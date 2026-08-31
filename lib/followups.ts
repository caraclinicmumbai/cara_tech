// Per-lead follow-up roadmap (§follow-up roadmap). A lead carries an ordered list
// of follow-up steps — the "sales roadmap" — each with its own status and an
// accountable actor (a telecaller/counsellor rep, the sales head, or the AI).
//
// Steps are SEEDED from a standard template at intake and are hand-editable
// thereafter (add / complete / skip / reassign). Only pending | done | skipped
// are persisted; "missed" is DERIVED at read time (a pending step past its due
// date), so no background sweep is needed to turn a step red.
import { prisma } from "@/lib/prisma";
import { getSalesHead } from "@/lib/salesReps";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowUpChannel = "ai_call" | "call" | "whatsapp" | "quote" | "custom";
export type FollowUpOwnerKind = "ai" | "rep" | "sales_head";
/// The visual state a step renders as. `missed` is derived, never stored.
export type FollowUpVisualStatus = "done" | "missed" | "todo" | "skipped";

type TemplateStep = {
  title: string;
  channel: FollowUpChannel;
  dayOffset: number; // days after lead creation the step is due
  ownerKind: FollowUpOwnerKind;
};

/// The default follow-up roadmap seeded on every actively-pursued new lead. Owners
/// resolve at seed time: `rep` → the lead's assigned counsellor, `sales_head` →
/// the sales head, `ai` → the automated caller. Staff can edit any of it after.
export const FOLLOWUP_TEMPLATE: TemplateStep[] = [
  { title: "AI first call", channel: "ai_call", dayOffset: 0, ownerKind: "ai" },
  { title: "AI reconfirmation call", channel: "ai_call", dayOffset: 1, ownerKind: "ai" },
  { title: "Counsellor follow-up call", channel: "call", dayOffset: 3, ownerKind: "rep" },
  { title: "WhatsApp follow-up", channel: "whatsapp", dayOffset: 5, ownerKind: "rep" },
  { title: "Counsellor callback", channel: "call", dayOffset: 7, ownerKind: "rep" },
  { title: "Sales-head review", channel: "custom", dayOffset: 14, ownerKind: "sales_head" },
];

/// The same ladder for a lead the AI will never call — walk-ins, duplicates,
/// held-for-review, inbound callers. The AI steps are dropped and the human ones
/// re-based so the first touch lands the day after intake instead of on day 3.
function humanOnlyTemplate(): TemplateStep[] {
  const steps = FOLLOWUP_TEMPLATE.filter((t) => t.channel !== "ai_call");
  const shift = (steps[0]?.dayOffset ?? 1) - 1;
  return steps.map((t) => ({ ...t, dayOffset: t.dayOffset - shift }));
}

/// Seed the standard roadmap onto a lead. Idempotent — a no-op if the lead already
/// has any steps. Best-effort by design (never throws into the intake flow).
export async function seedFollowUpSteps(input: {
  leadId: string;
  ownerRepId: string | null;
  startAt: Date;
  /// false when this lead will never be auto-called, so the AI steps are pointless.
  /// Every lead gets a ladder either way — an empty Follow up column reads as "no
  /// plan", and that's exactly the lead that gets forgotten.
  aiCalling?: boolean;
}): Promise<number> {
  const existing = await prisma.leadFollowUpStep.count({ where: { leadId: input.leadId } });
  if (existing > 0) return 0;

  // Resolve the sales head once (may be null if none configured).
  const salesHead = await getSalesHead();

  const template = input.aiCalling === false ? humanOnlyTemplate() : FOLLOWUP_TEMPLATE;
  const rows = template.map((t, i) => {
    const ownerRepId =
      t.ownerKind === "rep" ? input.ownerRepId : t.ownerKind === "sales_head" ? (salesHead?.id ?? null) : null;
    return {
      leadId: input.leadId,
      order: i,
      title: t.title,
      channel: t.channel,
      dueAt: new Date(input.startAt.getTime() + t.dayOffset * DAY_MS),
      ownerKind: t.ownerKind,
      ownerRepId,
      source: "template",
    };
  });

  await prisma.leadFollowUpStep.createMany({ data: rows });
  return rows.length;
}

export type FollowUpStepView = {
  id: string;
  order: number;
  title: string;
  channel: string;
  dueAt: string | null; // ISO
  status: string; // stored: pending | done | skipped
  visual: FollowUpVisualStatus; // derived (adds "missed")
  completedAt: string | null; // ISO
  ownerKind: string;
  ownerRepId: string | null;
  ownerName: string; // resolved label: rep name, "AI", or "Unassigned"
  source: string;
  note: string | null;
};

/// The visual status a step renders as: done/skipped are stored outright; a
/// pending step with a past due date is `missed` (red); everything else is `todo`.
export function visualStatus(
  step: { status: string; dueAt: Date | null },
  now: number = Date.now(),
): FollowUpVisualStatus {
  if (step.status === "done") return "done";
  if (step.status === "skipped") return "skipped";
  if (step.dueAt && step.dueAt.getTime() < now) return "missed";
  return "todo";
}

/// The accountable actor's display label for a step.
function ownerLabel(step: { ownerKind: string; ownerRep: { name: string } | null }): string {
  if (step.ownerKind === "ai") return "AI";
  return step.ownerRep?.name ?? "Unassigned";
}

/// The lead's follow-up roadmap, ordered, with owners resolved + visual status.
export async function listFollowUpSteps(
  leadId: string,
  now: number = Date.now(),
): Promise<FollowUpStepView[]> {
  const steps = await prisma.leadFollowUpStep.findMany({
    where: { leadId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: { ownerRep: { select: { name: true } } },
  });
  return steps.map((s) => ({
    id: s.id,
    order: s.order,
    title: s.title,
    channel: s.channel,
    dueAt: s.dueAt ? s.dueAt.toISOString() : null,
    status: s.status,
    visual: visualStatus(s, now),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    ownerKind: s.ownerKind,
    ownerRepId: s.ownerRepId,
    ownerName: ownerLabel(s),
    source: s.source,
    note: s.note,
  }));
}

/// A compact roll-up for the section header, e.g. "2 done · 1 missed · 3 to do".
export function summariseRoadmap(steps: FollowUpStepView[]): string {
  if (steps.length === 0) return "No follow-up steps yet";
  const done = steps.filter((s) => s.visual === "done").length;
  const missed = steps.filter((s) => s.visual === "missed").length;
  const todo = steps.filter((s) => s.visual === "todo").length;
  const skipped = steps.filter((s) => s.visual === "skipped").length;
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (missed) parts.push(`${missed} missed`);
  if (todo) parts.push(`${todo} to do`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(" · ");
}

/// React to a call outcome so the roadmap tracks reality (§follow-up roadmap,
/// dynamic). Called post-commit from the call write-back — best-effort, never
/// throws into the caller. Two reactions:
///   • Consultation booked (outcome "confirmed") → complete every still-open step
///     and append a "Consultation booked" done milestone, owned by the lead's
///     counsellor (or AI if unassigned).
///   • Rescheduled / callback → realign the next pending call step's due date to
///     the scheduled callback time, so it reflects the plan and stops showing red.
/// The "consultation booked" reaction, shared by the AI-call outcome path and the
/// manual stage-move path. IDEMPOTENT: if a booking milestone already exists it does
/// nothing, so it's safe to call from more than one trigger for the same lead.
export async function bookConsultationOnRoadmap(input: {
  leadId: string;
  assignedRepId: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const already = await prisma.leadFollowUpStep.findFirst({
    where: { leadId: input.leadId, title: "Consultation booked", source: "auto" },
    select: { id: true },
  });
  if (already) return; // already recorded — don't append a second milestone

  const pendingCount = await prisma.leadFollowUpStep.count({
    where: { leadId: input.leadId, status: "pending" },
  });
  if (pendingCount > 0) {
    await prisma.leadFollowUpStep.updateMany({
      where: { leadId: input.leadId, status: "pending" },
      data: { status: "done", completedAt: now },
    });
  }
  const max = await prisma.leadFollowUpStep.aggregate({
    where: { leadId: input.leadId },
    _max: { order: true },
  });
  const hasRep = !!input.assignedRepId;
  await prisma.leadFollowUpStep.create({
    data: {
      leadId: input.leadId,
      order: (max._max.order ?? -1) + 1,
      title: "Consultation booked",
      channel: "custom",
      status: "done",
      completedAt: now,
      ownerKind: hasRep ? "rep" : "ai",
      ownerRepId: hasRep ? input.assignedRepId : null,
      source: "auto",
    },
  });
  await writeAudit({
    action: "lead.followup.autobook",
    entityType: "lead",
    entityId: input.leadId,
    newValue: `Consultation booked — ${pendingCount} open step(s) auto-completed`,
  });
  logger.info(`Roadmap: lead ${input.leadId} consultation booked — completed ${pendingCount} open step(s)`);
}

export async function applyCallOutcomeToRoadmap(input: {
  leadId: string;
  outcome: string | null; // confirmed | no_answer | rescheduled | not_interested
  callbackAt: Date | null;
  assignedRepId: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  try {
    if (input.outcome === "confirmed") {
      await bookConsultationOnRoadmap({ leadId: input.leadId, assignedRepId: input.assignedRepId, now });
      return;
    }

    // Rescheduled / explicit callback (not an opt-out): realign the next pending
    // call step to the scheduled time so it isn't left showing red.
    if (input.callbackAt && input.outcome !== "not_interested") {
      const pending = await prisma.leadFollowUpStep.findMany({
        where: { leadId: input.leadId, status: "pending" },
        orderBy: { order: "asc" },
      });
      const next = pending.find((s) => s.channel === "call") ?? pending[0];
      if (next) {
        await prisma.leadFollowUpStep.update({
          where: { id: next.id },
          data: { dueAt: input.callbackAt },
        });
        await writeAudit({
          action: "lead.followup.reschedule",
          entityType: "lead",
          entityId: input.leadId,
          field: next.title,
          newValue: input.callbackAt.toISOString(),
        });
        logger.info(`Roadmap: lead ${input.leadId} step "${next.title}" due date moved to callback ${input.callbackAt.toISOString()}`);
      }
    }
  } catch (err) {
    logger.error(`applyCallOutcomeToRoadmap failed for lead ${input.leadId}: ${String(err)}`);
  }
}

/// React to a manual pipeline-stage move (§follow-up roadmap, dynamic). This is the
/// HUMAN-call equivalent of the AI "confirmed" outcome: a counsellor who books a
/// consultation on a rep call records it by moving the lead to Appointment Scheduled.
/// Best-effort; never throws into the caller. Idempotent via bookConsultationOnRoadmap.
export async function applyStageChangeToRoadmap(input: {
  leadId: string;
  stage: string;
  assignedRepId: string | null;
  now?: Date;
}): Promise<void> {
  try {
    if (input.stage === "appointment_scheduled") {
      await bookConsultationOnRoadmap({ leadId: input.leadId, assignedRepId: input.assignedRepId, now: input.now });
    }
  } catch (err) {
    logger.error(`applyStageChangeToRoadmap failed for lead ${input.leadId}: ${String(err)}`);
  }
}

/// The lead's NEXT follow-up — the earliest pending step carrying a due date. This is
/// exactly what the leads table's "Follow up" column shows, so the editor and the
/// column can't disagree about which step is being changed.
export async function nextFollowUpStep(leadId: string) {
  return prisma.leadFollowUpStep.findFirst({
    where: { leadId, status: "pending", dueAt: { not: null } },
    orderBy: { dueAt: "asc" },
    select: { id: true, title: true, dueAt: true, channel: true },
  });
}

/// The next follow-up plus the ones queued behind it.
///
/// Leads are seeded with a small ladder of steps at intake, and only the earliest shows
/// in the column. That matters when someone edits the date: push the next step into
/// October and the step behind it becomes "next", so the screen would show a date the
/// counsellor didn't type and looks like the save failed. Handing the queue to the UI
/// lets it say what's actually there instead.
export async function followUpQueue(leadId: string): Promise<{
  next: { id: string; title: string; dueAt: Date | null } | null;
  laterCount: number;
  laterFirstAt: Date | null;
}> {
  const pending = await prisma.leadFollowUpStep.findMany({
    where: { leadId, status: "pending", dueAt: { not: null } },
    orderBy: { dueAt: "asc" },
    select: { id: true, title: true, dueAt: true },
  });
  return {
    next: pending[0] ?? null,
    laterCount: Math.max(0, pending.length - 1),
    laterFirstAt: pending[1]?.dueAt ?? null,
  };
}

/// Set (or clear) when this lead is next followed up.
///
/// The date lives on a roadmap STEP rather than on the lead, because a follow-up is
/// something somebody does — it has a title, an owner and a completion state. The
/// roadmap panel that used to edit these was removed when the clinic asked for "just
/// the dates", which left the column read-only; this is the narrow way back in.
///
/// Retargets the existing next step where there is one, so the counsellor moves the
/// work rather than accumulating duplicates. With no step to move, one is created and
/// owned by the lead's counsellor. Passing `null` clears the date, which takes the
/// step out of the column without deleting the work.
export async function setNextFollowUp(input: {
  leadId: string;
  dueAt: Date | null;
  title?: string | null;
}): Promise<{ stepId: string; previous: Date | null; created: boolean }> {
  const existing = await nextFollowUpStep(input.leadId);

  if (existing) {
    await prisma.leadFollowUpStep.update({
      where: { id: existing.id },
      data: {
        dueAt: input.dueAt,
        ...(input.title?.trim() ? { title: input.title.trim().slice(0, 120) } : {}),
      },
    });
    return { stepId: existing.id, previous: existing.dueAt, created: false };
  }

  // Nothing pending to move — add a step at the end of the roadmap. Clearing a date
  // that doesn't exist is a no-op rather than an empty step nobody asked for.
  if (!input.dueAt) return { stepId: "", previous: null, created: false };

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: { assignedRepId: true },
  });
  const max = await prisma.leadFollowUpStep.aggregate({
    where: { leadId: input.leadId },
    _max: { order: true },
  });
  const step = await prisma.leadFollowUpStep.create({
    data: {
      leadId: input.leadId,
      order: (max._max.order ?? -1) + 1,
      title: input.title?.trim().slice(0, 120) || "Follow up",
      channel: "custom",
      dueAt: input.dueAt,
      status: "pending",
      ownerKind: "rep",
      ownerRepId: lead?.assignedRepId ?? null,
      source: "manual",
    },
    select: { id: true },
  });
  return { stepId: step.id, previous: null, created: true };
}

// Best-effort seed helper for intake — logs and swallows failures so a roadmap
// hiccup never blocks lead creation.
export async function seedFollowUpStepsSafe(input: {
  leadId: string;
  ownerRepId: string | null;
  startAt: Date;
  aiCalling?: boolean;
}): Promise<void> {
  try {
    const n = await seedFollowUpSteps(input);
    if (n) logger.info(`Seeded ${n} follow-up steps for lead ${input.leadId}`);
  } catch (err) {
    logger.error(`Follow-up seed failed for lead ${input.leadId}: ${String(err)}`);
  }
}
