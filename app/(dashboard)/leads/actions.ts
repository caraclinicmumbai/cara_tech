"use server";

// Server Actions for staff edits to a lead's pipeline stage and tag (§3.1).
// Server Functions are reachable via direct POST, so EVERY action re-checks the
// session (see Next.js data-security guide) before touching the database.
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { isLeadStage, LOST_STAGE, isPreConsultation, stageLabel } from "@/lib/leadStages";
import { notifyCounsellor } from "@/lib/counsellor";
import { sendLeadText, sendLeadTemplate } from "@/lib/messages";
import { listApprovedTemplates, buildTemplateComponents, type WhatsAppTemplate } from "@/lib/whatsappTemplates";
import { clickToCall, isTwilioConfigured } from "@/lib/providers/twilio";
import { logger } from "@/lib/logger";

const TAG_MAX = 120;
const REASON_MAX = 300;
const MESSAGE_MAX = 4096; // WhatsApp text body limit

export async function setLeadStage(
  leadId: string,
  stage: string,
  reason?: string,
): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!isLeadStage(stage)) throw new Error("Invalid stage");

  // Moving to "Lost" requires a reason; any other stage clears a prior one.
  const isLost = stage === LOST_STAGE;
  const lostReason = reason?.trim().slice(0, REASON_MAX);
  if (isLost && !lostReason) throw new Error("A reason is required to mark a lead lost");

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { stage: true, name: true, phone: true },
  });
  if (!lead) throw new Error("Lead not found");
  const stageChanged = lead.stage !== stage;

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      stage,
      lostReason: isLost ? lostReason : null,
      lostAt: isLost ? new Date() : null,
      // Reset the stage-age clock + stuck-alert dedup whenever the stage moves.
      ...(stageChanged ? { stageChangedAt: new Date(), stageStuckNotifiedAt: null } : {}),
    },
  });
  logger.info(
    `Lead ${leadId} stage set to ${stage}${isLost ? ` (lost: ${lostReason})` : ""} by ${session.user.email ?? "?"}`,
  );

  // Premature lost (§3.1): the lead was marked Lost before ever completing a
  // consultation — alert the counsellor for a possible save.
  if (isLost && isPreConsultation(lead.stage)) {
    await notifyCounsellor({
      kind: "premature_lost",
      lead: { id: leadId, name: lead.name, phone: lead.phone },
      reason: lostReason,
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
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const text = body.trim().slice(0, MESSAGE_MAX);
  if (!text) return { ok: false, error: "Message is empty" };

  const res = await sendLeadText(leadId, text, { sentBy: session.user.email ?? undefined });
  revalidatePath(`/leads/${leadId}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/// Start a recorded click-to-call for a handed-over lead (§3.1). Twilio rings the
/// assigned rep's phone; when they answer it dials the lead, records, and the
/// recording is stored on the lead. Session-checked.
export async function callLeadAndRecord(
  leadId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!isTwilioConfigured()) return { ok: false, error: "Calling is not configured yet" };

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { assignedRep: true },
  });
  if (!lead) return { ok: false, error: "Lead not found" };
  const repPhone = lead.assignedRep?.phone;
  if (!repPhone) return { ok: false, error: "No assigned rep with a phone to call from" };

  const res = await clickToCall(repPhone, leadId);
  if (!res.ok) return { ok: false, error: res.error };
  logger.info(`Click-to-call started for lead ${leadId} (rep ${lead.assignedRep?.name}) by ${session.user.email}`);
  return { ok: true };
}

/// List APPROVED templates for the re-engagement picker (used when the 24h
/// window is closed). Session-checked since it hits the WABA via our token.
export async function listWhatsAppTemplates(): Promise<WhatsAppTemplate[]> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
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
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");
  if (!templateName) return { ok: false, error: "No template selected" };

  const components = buildTemplateComponents(params);
  const res = await sendLeadTemplate(leadId, templateName, languageCode, components, {
    automated: false,
    sentBy: session.user.email ?? undefined,
  });
  revalidatePath(`/leads/${leadId}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function setLeadTag(leadId: string, tag: string): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const trimmed = tag.trim().slice(0, TAG_MAX);
  await prisma.lead.update({
    where: { id: leadId },
    data: { tag: trimmed || null },
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}
