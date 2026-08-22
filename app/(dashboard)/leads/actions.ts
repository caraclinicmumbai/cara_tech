"use server";

// Server Actions for staff edits to a lead's pipeline stage and tag (§3.1).
// Server Functions are reachable via direct POST, so EVERY action re-checks the
// session (see Next.js data-security guide) before touching the database.
import { requireCapability, userCanAccessLead } from "@/lib/authz";
import { leadScope } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { isLeadStage, LOST_STAGE, isPreConsultation, stageLabel, isLostTag } from "@/lib/leadStages";
import { notifyCounsellor } from "@/lib/counsellor";
import { runStageChange } from "@/lib/chatbotRuntime";
import { applyStageChangeToRoadmap } from "@/lib/followups";
import { sendLeadText, sendLeadTemplate } from "@/lib/messages";
import { listApprovedTemplates, buildTemplateComponents, type WhatsAppTemplate } from "@/lib/whatsappTemplates";
import { clickToCall, isTwilioConfigured, deleteTwilioRecording } from "@/lib/providers/twilio";
import { beginConsultation } from "@/lib/presence";
import { cancelScheduledCalls } from "@/lib/queue";
import { writeAudit, auditLeadFieldUpdate, auditLeadFieldChanges } from "@/lib/audit";
import { logger } from "@/lib/logger";

const TAG_MAX = 120;
const REMARK_MAX = 500;
const REASON_MAX = 300;
const MESSAGE_MAX = 4096; // WhatsApp text body limit
const COMMENT_MAX = 4000;

export async function setLeadStage(
  leadId: string,
  stage: string,
  opts?: { lostTag?: string; reason?: string },
): Promise<void> {
  const isLostStage = stage === LOST_STAGE;
  const user = await requireCapability(isLostStage ? "leads.markLost" : "leads.editStage");
  if (!isLeadStage(stage)) throw new Error("Invalid stage");

  // Moving to "Lost" needs a preset tag AND/OR a written review. A tag makes the
  // review optional; with neither we reject. Any other stage clears a prior loss.
  const isLost = stage === LOST_STAGE;
  const lostTag = opts?.lostTag?.trim();
  const lostReason = opts?.reason?.trim().slice(0, REASON_MAX);
  if (isLost && lostTag && !isLostTag(lostTag)) throw new Error("Invalid lost tag");
  if (isLost && !lostTag && !lostReason) {
    throw new Error("Pick a preset tag or write a reason to mark a lead lost");
  }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { stage: true, name: true, phone: true, assignedRepId: true },
  });
  if (!lead) throw new Error("Lead not found");
  const stageChanged = lead.stage !== stage;
  const isPremature = isLost && isPreConsultation(lead.stage);

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      stage,
      lostTag: isLost ? (lostTag || null) : null,
      lostReason: isLost ? (lostReason || null) : null,
      lostAt: isLost ? new Date() : null,
      // Flag premature losses for the daily digest; clear it when un-lost.
      prematureLost: isLost ? isPremature : false,
      // Reset the stage-age clock + stuck-alert dedup whenever the stage moves.
      ...(stageChanged ? { stageChangedAt: new Date(), stageStuckNotifiedAt: null } : {}),
    },
  });
  const lostSummary = [lostTag, lostReason].filter(Boolean).join(" — ");
  // Audit: pipeline stage move (from → to), with the lost reason when marking lost.
  if (stageChanged) {
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: "lead.stage.move",
      entityType: "lead",
      entityId: leadId,
      oldValue: lead.stage,
      newValue: stage,
      reason: isLost ? (lostSummary || null) : null,
    });
  }
  logger.info(
    `Lead ${leadId} stage set to ${stage}${isLost ? ` (lost: ${lostSummary})` : ""} by ${user.email ?? "?"}`,
  );

  // §matrix: a stage change may auto-fire a chatbot flow for the new stage
  // (matched by stage × the lead's latest campaign). Best-effort; never blocks.
  if (stageChanged) {
    await runStageChange(leadId, stage).catch((err) =>
      logger.error(`Stage-change chatbot trigger failed for ${leadId}: ${String(err)}`),
    );
  }

  // Follow-up roadmap (§follow-up roadmap, dynamic) — moving a lead to Appointment
  // Scheduled is the human-call equivalent of a booked consultation: complete the
  // roadmap + add the "Consultation booked" milestone (idempotent). Best-effort.
  if (stageChanged) {
    await applyStageChangeToRoadmap({ leadId, stage, assignedRepId: lead.assignedRepId });
  }

  // Premature lost (§3.1): the lead was marked Lost before ever completing a
  // consultation — alert the counsellor for a possible save.
  if (isPremature) {
    await notifyCounsellor({
      kind: "premature_lost",
      lead: { id: leadId, name: lead.name, phone: lead.phone },
      reason: lostSummary || undefined,
      extra: [`Marked lost at *${stageLabel(lead.stage)}* — never completed a consultation.`],
    });
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

/// Manual WhatsApp reply from an agent (free-form, inside the 24h window). The
/// message is logged to the lead's thread stamped with the sending agent.
export async function sendLeadWhatsApp(
  leadId: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.whatsapp");

  const text = body.trim().slice(0, MESSAGE_MAX);
  if (!text) return { ok: false, error: "Message is empty" };

  const res = await sendLeadText(leadId, text, { sentBy: user.email ?? undefined });
  revalidatePath(`/leads/${leadId}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/// Start a recorded click-to-call for a handed-over lead (§3.1). Twilio rings the
/// assigned rep's phone; when they answer it dials the lead, records, and the
/// recording is stored on the lead. Session-checked.
export async function callLeadAndRecord(
  leadId: string,
): Promise<{ ok: boolean; error?: string; repName?: string }> {
  const user = await requireCapability("leads.call");
  if (!isTwilioConfigured()) return { ok: false, error: "Calling is not configured yet" };

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { assignedRep: true },
  });
  if (!lead) return { ok: false, error: "Lead not found" };

  // Prefer the assigned rep. Otherwise fall back to the least-recently-assigned
  // active telecaller — so a manual rep call still works for unassigned leads,
  // including opted-out ones (opt-out only blocks AUTOMATED calls, not a human
  // rep dialling back). Sales heads are excluded from the fallback (not the rota).
  let rep = lead.assignedRep;
  if (!rep?.phone) {
    rep = await prisma.salesRep.findFirst({
      where: { active: true, salesHead: false, NOT: { phone: "" } },
      orderBy: [{ lastAssignedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    });
  }
  if (!rep?.phone) return { ok: false, error: "No rep with a phone to call from" };

  const res = await clickToCall(rep.phone, leadId, rep.id);
  if (!res.ok) return { ok: false, error: res.error };
  // §presence auto-detect: the rep is now on a call on their work number — mark them
  // In-Consultation without asking. The Twilio recording webhook reverts them when
  // the call ends. Best-effort; never blocks the call.
  void beginConsultation(rep.id);
  logger.info(`Click-to-call started for lead ${leadId} (rep ${rep.name}) by ${user.email}`);
  return { ok: true, repName: rep.name };
}

/// List APPROVED templates for the re-engagement picker (used when the 24h
/// window is closed). Session-checked since it hits the WABA via our token.
export async function listWhatsAppTemplates(): Promise<WhatsAppTemplate[]> {
  await requireCapability("leads.whatsapp");
  return listApprovedTemplates();
}

/// Send an approved template to re-open the chat (works outside the 24h window).
/// `params` fills the template's {{1}}, {{2}}… body variables, in order.
export async function sendLeadWhatsAppTemplate(
  leadId: string,
  templateName: string,
  languageCode: string,
  params: string[] = [],
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.whatsapp");
  if (!templateName) return { ok: false, error: "No template selected" };

  const components = buildTemplateComponents(params);
  const res = await sendLeadTemplate(leadId, templateName, languageCode, components, {
    automated: false,
    sentBy: user.email ?? undefined,
  });
  revalidatePath(`/leads/${leadId}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function setLeadTag(leadId: string, tag: string): Promise<void> {
  const user = await requireCapability("leads.editTag");

  const trimmed = tag.trim().slice(0, TAG_MAX);
  const before = await prisma.lead.findUnique({ where: { id: leadId }, select: { tag: true } });
  await prisma.lead.update({
    where: { id: leadId },
    data: { tag: trimmed || null },
  });
  await auditLeadFieldUpdate(user, leadId, "tag", before?.tag ?? null, trimmed || null);

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

/// Edit the lead's one-line staff remark, inline from the leads dashboard.
/// Audited like any other staff field edit (old → new).
export async function setLeadRemark(leadId: string, remark: string): Promise<void> {
  const user = await requireCapability("leads.comment");
  if (!(await userCanAccessLead(user, leadId))) throw new Error("Lead not found");

  const trimmed = remark.trim().slice(0, REMARK_MAX);
  const before = await prisma.lead.findUnique({ where: { id: leadId }, select: { remark: true } });
  if (!before) throw new Error("Lead not found");
  await prisma.lead.update({
    where: { id: leadId },
    data: { remark: trimmed || null },
  });
  await auditLeadFieldUpdate(user, leadId, "remark", before.remark, trimmed || null);

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

/// Edit a lead's core details (name / phone / email / interest). Each changed field is
/// audited (old → new). Changing the phone number requires a written reason
/// (compliance-sensitive — consent is tied to the number).
export async function editLead(
  leadId: string,
  input: { name: string; phone: string; email?: string | null; interest?: string | null; reason?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.edit");
  if (!(await userCanAccessLead(user, leadId))) return { ok: false, error: "Not found" };

  const before = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { name: true, phone: true, email: true, interest: true },
  });
  if (!before) return { ok: false, error: "Lead not found" };

  const name = input.name.trim();
  const phone = input.phone.trim();
  const email = (input.email ?? "").trim() || null;
  const interest = (input.interest ?? "").trim() || null;
  if (!name) return { ok: false, error: "Name is required" };
  if (!phone) return { ok: false, error: "Phone is required" };

  const reason = (input.reason ?? "").trim() || null;
  const phoneChanged = phone !== before.phone;
  if (phoneChanged && !reason) return { ok: false, error: "A reason is required to change the phone number" };

  await prisma.lead.update({ where: { id: leadId }, data: { name, phone, email, interest } });

  // Audit each changed field; the phone change carries its mandatory reason.
  await auditLeadFieldChanges(user, leadId, before, { name, email, interest }, ["name", "email", "interest"]);
  await auditLeadFieldUpdate(user, leadId, "phone", before.phone, phone, reason);

  logger.info(`Lead ${leadId} details edited by ${user.email ?? "?"}${phoneChanged ? " (phone changed)" : ""}`);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

/// Merge a duplicate lead into its original (§3.1.1). Moves the duplicate's calls,
/// messages, and any leads that pointed at it onto the original, backfills fields
/// the original is missing from the duplicate (never overwrites existing data),
/// then deletes the duplicate. Returns the original's id so the UI can navigate.
export async function mergeDuplicateLead(
  leadId: string,
): Promise<{ ok: true; originalId: string } | { ok: false; error: string }> {
  const user = await requireCapability("leads.merge");

  const dup = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { duplicateOf: { include: { assignedRep: { select: { id: true, name: true } } } } },
  });
  if (!dup) return { ok: false, error: "Lead not found" };
  if (!dup.duplicateOfId || !dup.duplicateOf) {
    return { ok: false, error: "This lead isn't marked as a duplicate of another" };
  }
  const original = dup.duplicateOf;
  const originalId = original.id;

  // Ownership after a merge belongs to the counsellor who was already working the
  // patient — the ORIGINAL's owner (§3.1.1). The re-enquiry that came in as this
  // duplicate was round-robined to whoever was next on the rota, which would
  // otherwise hand a relationship to a second person mid-conversation. Backfill
  // semantics apply only when the original has nobody: then the duplicate's owner
  // is better than none.
  const keepRepId = original.assignedRepId ?? dup.assignedRepId;
  const ownerChanged = keepRepId !== original.assignedRepId;

  try {
    await prisma.$transaction(async (tx) => {
      // Re-parent the duplicate's call + message history onto the original.
      await tx.call.updateMany({ where: { leadId: dup.id }, data: { leadId: originalId } });
      await tx.message.updateMany({ where: { leadId: dup.id }, data: { leadId: originalId } });
      // Any lead that considered THIS one its original now points at the survivor.
      await tx.lead.updateMany({ where: { duplicateOfId: dup.id }, data: { duplicateOfId: originalId } });
      // Backfill only the fields the original is missing (don't clobber its data).
      await tx.lead.update({
        where: { id: originalId },
        data: {
          email: original.email ?? dup.email,
          interest: original.interest ?? dup.interest,
          tag: original.tag ?? dup.tag,
          campaign: original.campaign ?? dup.campaign,
          adId: original.adId ?? dup.adId,
          externalId: original.externalId ?? dup.externalId,
          // Stays with the original's counsellor; only filled from the duplicate
          // when the original had no owner at all.
          ...(ownerChanged && keepRepId
            ? { assignedRepId: keepRepId, assignedAt: new Date() }
            : {}),
        },
      });
      await tx.lead.delete({ where: { id: dup.id } });
    });
  } catch (err) {
    logger.error(`Merge lead ${dup.id} → ${originalId} failed: ${String(err)}`);
    return { ok: false, error: "Merge failed — please try again" };
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.merge",
    entityType: "lead",
    entityId: originalId,
    oldValue: dup.name,
    newValue: original.name,
    meta: {
      mergedFromId: dup.id,
      mergedFromPhone: dup.phone,
      // Who the merged record belongs to afterwards, and whether that was inherited
      // from the duplicate because the original had no owner.
      ownerRepId: keepRepId,
      ownerFilledFromDuplicate: ownerChanged,
    },
  });
  logger.info(
    `Merged duplicate lead ${dup.id} into ${originalId} by ${user.email ?? "?"}` +
      ` (owner ${original.assignedRep?.name ?? (ownerChanged ? "inherited from the duplicate" : "none")})`,
  );
  revalidatePath("/leads");
  revalidatePath(`/leads/${originalId}`);
  return { ok: true, originalId };
}

/// Soft-delete a lead (§3.1) — move it to the Deleted section. It's hidden from the
/// leads list, metrics, dedup, and calling; any pending calls are cancelled. It can
/// be restored or permanently removed from the Deleted page.
export async function softDeleteLead(leadId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.softDelete");

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { deletedAt: true } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (lead.deletedAt) return { ok: true }; // already in trash

  await prisma.lead.update({
    where: { id: leadId },
    data: { deletedAt: new Date(), deletedBy: user.email ?? null },
  });
  await cancelScheduledCalls(leadId).catch((err) =>
    logger.error(`Failed to cancel calls for deleted lead ${leadId}: ${String(err)}`),
  );
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: "lead.softDelete", entityType: "lead", entityId: leadId });
  logger.info(`Lead ${leadId} moved to trash by ${user.email ?? "?"}`);
  revalidatePath("/leads");
  revalidatePath("/leads/deleted");
  return { ok: true };
}

/// Restore a soft-deleted lead back into the active list.
export async function restoreLead(leadId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.restore");

  await prisma.lead.update({
    where: { id: leadId },
    data: { deletedAt: null, deletedBy: null },
  });
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: "lead.restore", entityType: "lead", entityId: leadId });
  logger.info(`Lead ${leadId} restored by ${user.email ?? "?"}`);
  revalidatePath("/leads");
  revalidatePath("/leads/deleted");
  return { ok: true };
}

/// Permanently delete a lead (and its calls/messages, via cascade). Guarded: only
/// leads already in the trash can be permanently removed.
export async function permanentlyDeleteLead(leadId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.permanentDelete");

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { deletedAt: true, name: true, phone: true } });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (!lead.deletedAt) return { ok: false, error: "Move the lead to trash first" };

  // Right-to-erasure (§compliance C3): delete the actual call recordings from Twilio
  // BEFORE we drop the DB rows — otherwise the audio lingers on the provider with no
  // reference to clean it up. Best-effort; the DB delete proceeds regardless.
  const recordings = await prisma.call.findMany({
    where: { leadId, recordingUrl: { not: null } },
    select: { recordingUrl: true },
  });
  for (const c of recordings) {
    if (c.recordingUrl) await deleteTwilioRecording(c.recordingUrl);
  }

  await prisma.lead.delete({ where: { id: leadId } });
  await writeAudit({
    actorId: user.id, actorEmail: user.email, action: "lead.permanentDelete",
    entityType: "lead", entityId: leadId, oldValue: `${lead.name} (${lead.phone})`,
  });
  logger.info(`Lead ${leadId} permanently deleted by ${user.email ?? "?"}`);
  revalidatePath("/leads/deleted");
  return { ok: true };
}

/// Add a staff note / comment to a lead (§notes). Anyone who works the lead (and can
/// access it under the ownership scope) may comment. The author's name is snapshotted
/// so attribution survives if the login is later removed.
export async function addLeadComment(
  leadId: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.comment");
  if (!(await userCanAccessLead(user, leadId))) return { ok: false, error: "Not found" };

  const text = body.trim().slice(0, COMMENT_MAX);
  if (!text) return { ok: false, error: "Comment can't be empty" };

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) return { ok: false, error: "Lead not found" };

  await prisma.leadComment.create({
    data: { leadId, authorId: user.id, authorName: user.name ?? user.email ?? null, body: text },
  });
  await writeAudit({
    actorId: user.id, actorEmail: user.email, action: "lead.comment.add",
    entityType: "lead", entityId: leadId,
  });
  logger.info(`Comment added to lead ${leadId} by ${user.email ?? "?"}`);
  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

/// Delete a lead comment (§notes). The author may delete their own; a manager (all-leads
/// scope) may delete anyone's.
export async function deleteLeadComment(
  commentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCapability("leads.comment");

  const comment = await prisma.leadComment.findUnique({
    where: { id: commentId },
    select: { id: true, leadId: true, authorId: true },
  });
  if (!comment) return { ok: false, error: "Comment not found" };
  if (!(await userCanAccessLead(user, comment.leadId))) return { ok: false, error: "Not found" };

  const isAuthor = !!comment.authorId && comment.authorId === user.id;
  const isManager = leadScope(user.role ?? "") === "all";
  if (!isAuthor && !isManager) return { ok: false, error: "You can only delete your own comments" };

  await prisma.leadComment.delete({ where: { id: commentId } });
  await writeAudit({
    actorId: user.id, actorEmail: user.email, action: "lead.comment.delete",
    entityType: "lead", entityId: comment.leadId, meta: { commentId },
  });
  revalidatePath(`/leads/${comment.leadId}`);
  return { ok: true };
}
