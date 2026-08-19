// Post-sales journey lifecycle (§post-sales). The rules that keep the clinical track
// honest live here, so every caller enforces them identically:
//
//   • ONE journey per CONVERTED quote — never per lead. A patient with two converted
//     treatments has two journeys running at their own speeds.
//   • A journey opens only when the quote reaches `converted` (an invoice exists).
//   • Forward moves are free; a BACKWARD move needs a written reason (audited), so a
//     postponed surgery or a mis-click explains itself in the permanent log.
//   • Entering `surgery_done` requires a surgery date, and that date anchors the whole
//     day 1 / 7 / 30 / 90 check-in schedule.
//   • Every move re-arms the stage clock from the treatment's policy and clears the
//     overdue-alert dedup, so the next stall alerts afresh.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  FIRST_JOURNEY_STAGE,
  JOURNEY_STAGE_LABELS,
  SURGERY_STAGE,
  TERMINAL_JOURNEY_STAGE,
  isBackwardMove,
  isJourneyStage,
  type JourneyStage,
} from "@/lib/postSales/stages";
import { getPolicy, resolveTreatmentType, stageDueAt } from "@/lib/postSales/policy";
import { snapshotHandoverSummary } from "@/lib/postSales/handover";
import { scheduleCheckIns, clearScheduledCheckIns } from "@/lib/postSales/checkins";

export class JourneyError extends Error {}

/// Open the post-sales journey for a freshly converted quote. Called from the quote
/// conversion path (lib/quotes.ts) — and idempotent, so the billing webhook, a manual
/// conversion, and the backfill script can all call it without creating duplicates
/// (the DB's unique index on quoteId is the real guarantee; P2002 is treated as "already
/// open" rather than an error).
///
/// Returns the journey id, or null when the quote isn't eligible (not converted / gone).
export async function openJourneyForQuote(quoteId: string): Promise<string | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      leadId: true,
      treatment: true,
      status: true,
      branchId: true,
      invoicedBranchId: true,
      ownerRep: { select: { user: { select: { id: true } } } },
      journey: { select: { id: true } },
    },
  });
  if (!quote) return null;
  if (quote.journey) return quote.journey.id; // already open — idempotent
  // Only a WON quote gets a journey. "Converted" means an invoice exists for it.
  if (!["converted", "in_treatment", "completed"].includes(quote.status)) return null;

  const treatmentType = resolveTreatmentType(quote.treatment);
  const policy = await getPolicy(treatmentType);
  const now = new Date();

  // The branch that INVOICED earns the credit (§billing); fall back to the branch the
  // quote was raised at until billing has told us. Snapshotted so a later branch edit
  // doesn't retro-move a journey between clinics.
  const branchId = quote.invoicedBranchId ?? quote.branchId;

  let journeyId: string;
  try {
    const created = await prisma.postSalesJourney.create({
      data: {
        quoteId: quote.id,
        leadId: quote.leadId,
        stage: FIRST_JOURNEY_STAGE,
        stageChangedAt: now,
        stageDueAt: stageDueAt(policy, FIRST_JOURNEY_STAGE, now),
        treatmentType,
        branchId,
        openedAt: now,
      },
      select: { id: true },
    });
    journeyId = created.id;
  } catch (err) {
    // Unique violation on quoteId — a concurrent caller won the race. Return theirs.
    if ((err as { code?: string }).code === "P2002") {
      const existing = await prisma.postSalesJourney.findUnique({
        where: { quoteId: quote.id },
        select: { id: true },
      });
      return existing?.id ?? null;
    }
    throw err;
  }

  // The handover summary is generated per converted quote (§"Handing Over Cleanly").
  await snapshotHandoverSummary(journeyId, quote.id);

  await writeAudit({
    action: "postsales.journey.open",
    entityType: "quote",
    entityId: quote.id,
    newValue: JOURNEY_STAGE_LABELS[FIRST_JOURNEY_STAGE],
    meta: { journeyId, leadId: quote.leadId, treatment: quote.treatment, treatmentType, branchId },
  });
  logger.info(
    `Post-sales journey ${journeyId} opened for quote ${quote.id} ("${quote.treatment}", policy ${treatmentType})`,
  );
  return journeyId;
}

/// Best-effort wrapper for the conversion path — a journey hiccup must never fail the
/// conversion itself (the money already moved). The backfill script and the overdue
/// sweep both surface any journey that failed to open.
export async function openJourneyForQuoteSafe(quoteId: string): Promise<void> {
  try {
    await openJourneyForQuote(quoteId);
  } catch (err) {
    logger.error(`Failed to open post-sales journey for quote ${quoteId}: ${String(err)}`);
  }
}

export type MoveStageInput = {
  journeyId: string;
  to: string;
  /// Required for a backward move; optional (and recorded) for a forward one.
  reason?: string | null;
  /// Required when entering `surgery_done` — anchors the check-in schedule.
  surgeryAt?: Date | null;
  /// Sign-off note when closing the journey.
  closedNote?: string | null;
  actor?: { id?: string | null; email?: string | null };
};

/// Move a journey to a new stage. Re-arms the stage clock, clears the overdue dedup,
/// generates the check-in schedule on entry to `surgery_done`, and writes the move to
/// the permanent log with whatever reason was given.
export async function moveJourneyStage(input: MoveStageInput): Promise<void> {
  if (!isJourneyStage(input.to)) throw new JourneyError("Unknown post-sales stage");

  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: input.journeyId },
    select: {
      id: true,
      quoteId: true,
      leadId: true,
      stage: true,
      treatmentType: true,
      surgeryAt: true,
      checkInsScheduledAt: true,
    },
  });
  if (!journey) throw new JourneyError("Journey not found");

  const from = journey.stage;
  const to = input.to as JourneyStage;
  if (from === to) return; // no-op rather than an error — double-clicks happen

  const reason = input.reason?.trim() || null;
  // A backward move must explain itself — the clinical trail is only useful if a
  // reversal says why (§audit: a written reason in the permanent log).
  if (isBackwardMove(from, to) && !reason) {
    throw new JourneyError(
      `Moving back from ${JOURNEY_STAGE_LABELS[from as JourneyStage]} to ${JOURNEY_STAGE_LABELS[to]} needs a written reason.`,
    );
  }

  // Entering "Surgery Done" needs the date the surgery actually happened — the whole
  // check-in schedule hangs off it, so it can't be left implicit.
  let surgeryAt = journey.surgeryAt;
  if (to === SURGERY_STAGE) {
    surgeryAt = input.surgeryAt ?? journey.surgeryAt ?? null;
    if (!surgeryAt) {
      throw new JourneyError("Record the surgery date — the check-in schedule is anchored to it.");
    }
    if (surgeryAt.getTime() > Date.now() + 60_000) {
      throw new JourneyError("The surgery date can't be in the future.");
    }
  }

  const now = new Date();
  const policy = await getPolicy(journey.treatmentType);
  const due = stageDueAt(policy, to, now);

  await prisma.postSalesJourney.update({
    where: { id: journey.id },
    data: {
      stage: to,
      stageChangedAt: now,
      stageDueAt: due,
      overdueNotifiedAt: null, // the next stall alerts afresh
      surgeryAt,
      closedAt: to === TERMINAL_JOURNEY_STAGE ? now : null,
      closedNote: to === TERMINAL_JOURNEY_STAGE ? (input.closedNote?.trim() || reason) : null,
    },
  });

  await writeAudit({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    action: "postsales.stage.move",
    entityType: "quote",
    entityId: journey.quoteId,
    field: "journeyStage",
    oldValue: from,
    newValue: to,
    reason,
    meta: {
      journeyId: journey.id,
      leadId: journey.leadId,
      backward: isBackwardMove(from, to),
      surgeryAt: surgeryAt?.toISOString() ?? null,
    },
  });
  logger.info(
    `Post-sales journey ${journey.id}: ${from} → ${to}${reason ? ` (${reason})` : ""} by ${input.actor?.email ?? "system"}`,
  );

  // Generate the day 1/7/30/90 schedule on entry to Surgery Done (idempotent — it
  // no-ops when the schedule already matches this surgery date).
  if (to === SURGERY_STAGE && surgeryAt) {
    await scheduleCheckIns({ journeyId: journey.id, surgeryAt }).catch((err) =>
      logger.error(`Check-in scheduling failed for journey ${journey.id}: ${String(err)}`),
    );
  }
}

/// Correct the recorded surgery date. Re-anchors every check-in that hasn't gone out
/// yet — a date typed wrong shouldn't leave a patient's day-7 message landing on the
/// wrong day. Already-sent check-ins are left exactly as they are.
export async function setSurgeryDate(input: {
  journeyId: string;
  surgeryAt: Date;
  actor?: { id?: string | null; email?: string | null };
}): Promise<void> {
  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: input.journeyId },
    select: { id: true, quoteId: true, surgeryAt: true, stage: true },
  });
  if (!journey) throw new JourneyError("Journey not found");
  if (input.surgeryAt.getTime() > Date.now() + 60_000) {
    throw new JourneyError("The surgery date can't be in the future.");
  }

  await prisma.postSalesJourney.update({
    where: { id: journey.id },
    data: { surgeryAt: input.surgeryAt },
  });
  await writeAudit({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    action: "postsales.surgery.date",
    entityType: "quote",
    entityId: journey.quoteId,
    field: "surgeryAt",
    oldValue: journey.surgeryAt?.toISOString() ?? null,
    newValue: input.surgeryAt.toISOString(),
    meta: { journeyId: journey.id },
  });

  // Re-anchor the schedule: drop the un-sent rows, then regenerate from the new date.
  await clearScheduledCheckIns(journey.id);
  await scheduleCheckIns({ journeyId: journey.id, surgeryAt: input.surgeryAt });
  logger.info(`Journey ${journey.id} surgery date set to ${input.surgeryAt.toISOString()} — check-ins re-anchored`);
}

/// The three post-sales assignment slots. Each is a staff LOGIN so the accountable
/// person can act on their own stage.
export type AssignmentRole = "doctor" | "otLead" | "consultant";

const ASSIGNMENT_FIELD: Record<AssignmentRole, "doctorId" | "otLeadId" | "consultantId"> = {
  doctor: "doctorId",
  otLead: "otLeadId",
  consultant: "consultantId",
};

const ASSIGNMENT_LABEL: Record<AssignmentRole, string> = {
  doctor: "Doctor",
  otLead: "OT lead",
  consultant: "Post-sales consultant",
};

/// Assign (or clear) one of the clinical roles on a journey.
export async function assignJourneyStaff(input: {
  journeyId: string;
  role: AssignmentRole;
  userId: string | null;
  actor?: { id?: string | null; email?: string | null };
}): Promise<void> {
  const field = ASSIGNMENT_FIELD[input.role];
  if (!field) throw new JourneyError("Unknown post-sales role");

  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: input.journeyId },
    select: { id: true, quoteId: true, doctorId: true, otLeadId: true, consultantId: true },
  });
  if (!journey) throw new JourneyError("Journey not found");

  if (input.userId) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!user) throw new JourneyError("That staff member no longer exists");
  }

  await prisma.postSalesJourney.update({
    where: { id: journey.id },
    data: { [field]: input.userId },
  });
  await writeAudit({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    action: "postsales.assign",
    entityType: "quote",
    entityId: journey.quoteId,
    field: ASSIGNMENT_LABEL[input.role],
    oldValue: journey[field] ?? null,
    newValue: input.userId,
    meta: { journeyId: journey.id, role: input.role },
  });
}

/// Regenerate the handover summary snapshot on demand — used when sales corrects the
/// patient's language / flags / notes after the handover already happened.
export async function regenerateHandover(journeyId: string, actor?: { id?: string | null; email?: string | null }): Promise<void> {
  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: journeyId },
    select: { id: true, quoteId: true },
  });
  if (!journey) throw new JourneyError("Journey not found");
  await snapshotHandoverSummary(journey.id, journey.quoteId);
  await writeAudit({
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: "postsales.handover.regenerate",
    entityType: "quote",
    entityId: journey.quoteId,
    meta: { journeyId: journey.id },
  });
}
