// Per-lead follow-ups (§follow-up). A lead carries a list of follow-up steps, each with
// a due date, a status and an accountable person (its telecaller, or the sales head).
// Older leads may still hold AI-owned steps from before AI calling stopped.
//
// Each new lead is seeded with ONE step at intake (seedFollowUpSteps); staff can add
// more, mark them done or remove them from the lead page. Only pending | done | skipped
// are persisted; "missed" is DERIVED at read time (a pending step past its due
// date), so no background sweep is needed to turn a step red.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/// The visual state a step renders as. `missed` is derived, never stored.
export type FollowUpVisualStatus = "done" | "missed" | "todo" | "skipped";

/// Every new lead gets ONE follow-up (clinic decision, 2026-11-09): the six-step ladder
/// it replaced kept two AI-call steps nobody does since AI calling stopped, and showed
/// dates nobody had chosen. More can be added by hand from the lead page.
///
/// A lead that came in on its own (form, ad, WhatsApp) is due a call straight away: the
/// reminder sweep then pings its telecaller within minutes, which is the speed-to-call
/// target. A lead someone is already dealing with (walk-in, inbound caller, duplicate,
/// held for review) is due the next day.
export async function seedFollowUpSteps(input: {
  leadId: string;
  ownerRepId: string | null;
  startAt: Date;
  /// true when nobody has spoken to this lead yet, so the first call is due now.
  callNow: boolean;
}): Promise<number> {
  const existing = await prisma.leadFollowUpStep.count({ where: { leadId: input.leadId } });
  if (existing > 0) return 0;

  await prisma.leadFollowUpStep.create({
    data: {
      leadId: input.leadId,
      order: 0,
      title: input.callNow ? "First call" : "Follow up",
      channel: "call",
      dueAt: input.callNow ? input.startAt : new Date(input.startAt.getTime() + DAY_MS),
      ownerKind: "rep",
      ownerRepId: input.ownerRepId,
      source: "template",
    },
  });
  return 1;
}

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
    select: { id: true, title: true, dueAt: true, channel: true, ownerKind: true },
  });
}

/// Every pending follow-up with a date, soonest first. The first is the lead's "next"
/// follow-up (the one the leads table shows); the rest are the extra ones staff added.
export async function pendingFollowUps(leadId: string, now: number = Date.now()) {
  const steps = await prisma.leadFollowUpStep.findMany({
    where: { leadId, status: "pending", dueAt: { not: null } },
    orderBy: [{ dueAt: "asc" }, { order: "asc" }],
    select: { id: true, title: true, dueAt: true },
  });
  return steps.map((s) => ({ id: s.id, title: s.title, dueAt: s.dueAt!, overdue: s.dueAt!.getTime() < now }));
}

/// Add another follow-up to a lead, owned by its telecaller.
export async function addFollowUp(input: { leadId: string; dueAt: Date; title?: string | null }): Promise<string> {
  const [lead, max] = await Promise.all([
    prisma.lead.findUnique({ where: { id: input.leadId }, select: { assignedRepId: true } }),
    prisma.leadFollowUpStep.aggregate({ where: { leadId: input.leadId }, _max: { order: true } }),
  ]);
  const step = await prisma.leadFollowUpStep.create({
    data: {
      leadId: input.leadId,
      order: (max._max.order ?? -1) + 1,
      title: input.title?.trim().slice(0, 120) || "Follow up",
      channel: "call",
      dueAt: input.dueAt,
      status: "pending",
      ownerKind: "rep",
      ownerRepId: lead?.assignedRepId ?? null,
      source: "manual",
    },
    select: { id: true },
  });
  return step.id;
}

/// Close one pending follow-up: `done` when it happened, `skipped` when it's removed.
/// The row stays (with who and when) so the history isn't lost. Returns its title, or
/// null when it isn't a pending step of this lead.
export async function closeFollowUp(input: {
  leadId: string;
  stepId: string;
  status: "done" | "skipped";
  userId: string | null;
}): Promise<string | null> {
  const step = await prisma.leadFollowUpStep.findFirst({
    where: { id: input.stepId, leadId: input.leadId, status: "pending" },
    select: { title: true },
  });
  if (!step) return null;
  await prisma.leadFollowUpStep.update({
    where: { id: input.stepId },
    data: { status: input.status, completedAt: new Date(), completedById: input.userId },
  });
  return step.title;
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
    // An AI step left over from before AI calling stopped becomes the telecaller's when
    // someone moves it, or it would never remind anybody.
    const fromAi = existing.ownerKind === "ai";
    const owner = fromAi
      ? await prisma.lead.findUnique({ where: { id: input.leadId }, select: { assignedRepId: true } })
      : null;
    await prisma.leadFollowUpStep.update({
      where: { id: existing.id },
      data: {
        dueAt: input.dueAt,
        ...(fromAi ? { ownerKind: "rep", ownerRepId: owner?.assignedRepId ?? null, channel: "call" } : {}),
        // Moving the date arms a fresh reminder (§follow-up reminders). Without this,
        // a step reminded once would never remind again however often it was
        // rescheduled — the reschedule is exactly when a reminder matters most.
        remindedAt: null,
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
  callNow: boolean;
}): Promise<void> {
  try {
    if (await seedFollowUpSteps(input)) logger.info(`Seeded the follow-up for lead ${input.leadId}`);
  } catch (err) {
    logger.error(`Follow-up seed failed for lead ${input.leadId}: ${String(err)}`);
  }
}
