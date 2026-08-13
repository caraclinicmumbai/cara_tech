"use server";

// Server Actions for the per-lead follow-up roadmap (§follow-up roadmap). Like the
// other lead actions, every function re-checks the caller's capability (Server
// Functions are reachable via direct POST) and re-checks lead access so a scoped
// user can't act on a lead they can't see. Every mutation writes an audit row so
// the roadmap's history lands in the lead's change log.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability, userCanAccessLead, type SessionUser } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string };

const TITLE_MAX = 120;
const NOTE_MAX = 300;
const CHANNELS = new Set(["ai_call", "call", "whatsapp", "quote", "custom"]);
const OWNER_KINDS = new Set(["ai", "rep", "sales_head"]);

async function assertCanSeeLead(
  user: SessionUser,
  leadId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await userCanAccessLead(user, leadId)) return { ok: true };
  return { ok: false, error: "Not found" };
}

/// Load a step and confirm it belongs to the given lead (guards against a step id
/// from another lead being paired with a lead the caller can see).
async function stepForLead(stepId: string, leadId: string) {
  const step = await prisma.leadFollowUpStep.findUnique({ where: { id: stepId } });
  if (!step || step.leadId !== leadId) return null;
  return step;
}

/// Normalise the accountable owner: `ai` steps never carry a rep; `rep`/`sales_head`
/// keep the chosen rep (or null = Unassigned). Unknown kinds fall back to `rep`.
function normaliseOwner(ownerKind?: string | null, ownerRepId?: string | null) {
  const kind = ownerKind && OWNER_KINDS.has(ownerKind) ? ownerKind : "rep";
  return { ownerKind: kind, ownerRepId: kind === "ai" ? null : ownerRepId || null };
}

/// Add a manual step to the end of a lead's roadmap.
export async function addFollowUpStep(input: {
  leadId: string;
  title: string;
  channel?: string | null;
  dueAt?: string | null; // ISO / datetime-local
  ownerKind?: string | null;
  ownerRepId?: string | null;
  note?: string | null;
}): Promise<Result> {
  const user = await requireCapability("leads.edit");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const title = (input.title ?? "").trim().slice(0, TITLE_MAX);
  if (!title) return { ok: false, error: "A step title is required" };

  const channel = input.channel && CHANNELS.has(input.channel) ? input.channel : "custom";
  const { ownerKind, ownerRepId } = normaliseOwner(input.ownerKind, input.ownerRepId);

  let dueAt: Date | null = null;
  if (input.dueAt) {
    const d = new Date(input.dueAt);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid due date" };
    dueAt = d;
  }

  try {
    const last = await prisma.leadFollowUpStep.findFirst({
      where: { leadId: input.leadId },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    await prisma.leadFollowUpStep.create({
      data: {
        leadId: input.leadId,
        order: (last?.order ?? -1) + 1,
        title,
        channel,
        dueAt,
        ownerKind,
        ownerRepId,
        note: input.note?.trim().slice(0, NOTE_MAX) || null,
        source: "manual",
      },
    });
  } catch (err) {
    logger.error(`addFollowUpStep failed for ${input.leadId}: ${String(err)}`);
    return { ok: false, error: "Could not add the step" };
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.followup.add",
    entityType: "lead",
    entityId: input.leadId,
    newValue: title,
  });
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Mark a step done (green). Records who/when for the audit trail.
export async function completeFollowUpStep(input: { stepId: string; leadId: string }): Promise<Result> {
  const user = await requireCapability("leads.edit");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const step = await stepForLead(input.stepId, input.leadId);
  if (!step) return { ok: false, error: "Step not found" };

  await prisma.leadFollowUpStep.update({
    where: { id: step.id },
    data: { status: "done", completedAt: new Date(), completedById: user.id },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.followup.done",
    entityType: "lead",
    entityId: input.leadId,
    newValue: step.title,
  });
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Skip a step (grey) — not done, but no longer expected (so it never shows red).
export async function skipFollowUpStep(input: { stepId: string; leadId: string }): Promise<Result> {
  const user = await requireCapability("leads.edit");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const step = await stepForLead(input.stepId, input.leadId);
  if (!step) return { ok: false, error: "Step not found" };

  await prisma.leadFollowUpStep.update({
    where: { id: step.id },
    data: { status: "skipped", completedAt: new Date(), completedById: user.id },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.followup.skip",
    entityType: "lead",
    entityId: input.leadId,
    newValue: step.title,
  });
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Reopen a done/skipped step back to pending.
export async function reopenFollowUpStep(input: { stepId: string; leadId: string }): Promise<Result> {
  const user = await requireCapability("leads.edit");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const step = await stepForLead(input.stepId, input.leadId);
  if (!step) return { ok: false, error: "Step not found" };

  await prisma.leadFollowUpStep.update({
    where: { id: step.id },
    data: { status: "pending", completedAt: null, completedById: null },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.followup.reopen",
    entityType: "lead",
    entityId: input.leadId,
    newValue: step.title,
  });
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Reassign the accountable actor for a step (telecaller/counsellor, sales head, or AI).
export async function reassignFollowUpStep(input: {
  stepId: string;
  leadId: string;
  ownerKind: string;
  ownerRepId?: string | null;
}): Promise<Result> {
  const user = await requireCapability("leads.edit");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const step = await stepForLead(input.stepId, input.leadId);
  if (!step) return { ok: false, error: "Step not found" };

  const { ownerKind, ownerRepId } = normaliseOwner(input.ownerKind, input.ownerRepId);
  // Resolve names for the audit old→new (best-effort).
  const [oldRep, newRep] = await Promise.all([
    step.ownerRepId ? prisma.salesRep.findUnique({ where: { id: step.ownerRepId }, select: { name: true } }) : null,
    ownerRepId ? prisma.salesRep.findUnique({ where: { id: ownerRepId }, select: { name: true } }) : null,
  ]);
  const label = (kind: string, name?: string | null) => (kind === "ai" ? "AI" : name ?? "Unassigned");

  await prisma.leadFollowUpStep.update({
    where: { id: step.id },
    data: { ownerKind, ownerRepId },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.followup.reassign",
    entityType: "lead",
    entityId: input.leadId,
    field: step.title,
    oldValue: label(step.ownerKind, oldRep?.name),
    newValue: label(ownerKind, newRep?.name),
  });
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Remove a step from the roadmap entirely (manual cleanup).
export async function deleteFollowUpStep(input: { stepId: string; leadId: string }): Promise<Result> {
  const user = await requireCapability("leads.edit");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const step = await stepForLead(input.stepId, input.leadId);
  if (!step) return { ok: false, error: "Step not found" };

  await prisma.leadFollowUpStep.delete({ where: { id: step.id } });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.followup.delete",
    entityType: "lead",
    entityId: input.leadId,
    oldValue: step.title,
  });
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}
