// Post-surgery clinical check-ins (§post-sales). "Scheduled check-ins after each
// surgery on day 1, 7, 30, 90 via WhatsApp."
//
// Two things make this different from the sales follow-up campaigns:
//
//  1. THESE ARE MEDICAL MESSAGES, NOT MARKETING. They are governed by clinical
//     consent, so they go out even to a patient who opted out of promotions, and they
//     do not count against the marketing 12-in-30 ceiling. What DOES stop them: an
//     explicit clinical-consent withdrawal, and the hard safety flags — and those
//     don't silently drop the check-in, they turn it into a task for a human
//     (status `blocked`), because a post-op patient must not simply be forgotten.
//
//  2. THE PATIENT SEES ONE RELATIONSHIP, NOT TWO. A patient with a hair transplant
//     and a PRP course has two journeys, each with its own schedule, and those
//     schedules WILL collide. At most ONE care message per patient per IST day, across
//     every journey: when two land on the same morning the clinically closer one
//     (smaller day-offset) goes and the other is pushed a day. That is the whole
//     point — "two automated systems messaging the same patient on the same morning
//     about two different procedures is precisely the experience that makes a clinic
//     look disorganised."
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { sendAutomatedTemplate, firstName } from "@/lib/outreach";
import { isWithinQuietHours, nextAfterQuietHours, resolveQuietWindow } from "@/lib/campaigns/quietHours";
import { getPolicy } from "@/lib/postSales/policy";

const DAY_MS = 24 * 60 * 60 * 1000;
/// IST is UTC+5:30 with no DST, so day arithmetic is a fixed shift.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/// The IST wall-clock hour care messages are sent at. A post-op check-in should land
/// mid-morning, not at 3am when the row happens to become due.
function sendHour(): number {
  const h = Number(process.env.POSTSALES_CHECKIN_HOUR_IST ?? 10);
  return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 10;
}

/// A check-in that has been pushed this many times stops being pushed and becomes a
/// human task instead — a safety valve so a pile-up can't defer a patient forever.
const MAX_DEFERRALS = 7;

/// Give up automating after this many failed send attempts; the row goes to `failed`
/// so it shows on the board as something a person must pick up.
const MAX_ATTEMPTS = 3;

/// How many due check-ins to process per tick. Ample for a single clinic; the rest
/// are picked up next tick.
const TICK_BATCH = 200;

/// Is the post-sales check-in automation switched on? Off (the default) makes every
/// tick a no-op, so nothing goes out to a patient until the clinic says so and the
/// WhatsApp templates are approved.
export function checkInsEnabled(): boolean {
  return process.env.POSTSALES_CHECKINS_ENABLED === "true";
}

/// The approved WhatsApp template for a given day-offset. Per-offset env keys, with a
/// generic fallback for a custom offset. Unset = the check-in can't be automated (it
/// becomes a task), rather than silently vanishing.
export function checkInTemplate(dayOffset: number): string | undefined {
  const perDay = process.env[`POSTSALES_TEMPLATE_CHECKIN_D${dayOffset}`];
  return perDay || process.env.POSTSALES_TEMPLATE_CHECKIN_DEFAULT;
}

/// The IST calendar day of an instant, as a stable YYYY-MM-DD key. Used for the
/// one-care-message-per-patient-per-day rule.
export function istDayKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/// The instant at `sendHour()` IST on the IST day `days` after `from`'s IST day.
/// e.g. surgery at 14:00 IST on the 3rd, days=7 → 10:00 IST on the 10th.
function istSendInstant(from: Date, days: number, hour: number): Date {
  const shifted = from.getTime() + IST_OFFSET_MS;
  const istMidnight = Math.floor(shifted / DAY_MS) * DAY_MS;
  return new Date(istMidnight + days * DAY_MS + hour * 60 * 60 * 1000 - IST_OFFSET_MS);
}

/// Generate the check-in schedule for a journey from its surgery date. Idempotent:
/// re-running with the same date leaves existing rows alone (the unique index on
/// (journeyId, dayOffset) is the guarantee), so a stage re-entry can't double-book.
/// The day list comes from the treatment's policy — a PRP course doesn't need a
/// day-90 growth check, a transplant does.
export async function scheduleCheckIns(input: { journeyId: string; surgeryAt: Date }): Promise<number> {
  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: input.journeyId },
    select: { id: true, leadId: true, quoteId: true, treatmentType: true },
  });
  if (!journey) return 0;

  const policy = await getPolicy(journey.treatmentType);
  const hour = sendHour();

  const rows = policy.checkInDays.map((dayOffset) => {
    const at = istSendInstant(input.surgeryAt, dayOffset, hour);
    return {
      journeyId: journey.id,
      leadId: journey.leadId,
      dayOffset,
      scheduledFor: at,
      originalFor: at,
    };
  });

  // skipDuplicates makes this safe to call repeatedly (and safe against a race with
  // a concurrent stage move).
  const created = await prisma.postSalesCheckIn.createMany({ data: rows, skipDuplicates: true });
  await prisma.postSalesJourney.update({
    where: { id: journey.id },
    data: { checkInsScheduledAt: new Date() },
  });

  if (created.count > 0) {
    await writeAudit({
      action: "postsales.checkins.schedule",
      entityType: "quote",
      entityId: journey.quoteId,
      newValue: `day ${policy.checkInDays.join(" / ")} after ${input.surgeryAt.toISOString().slice(0, 10)}`,
      meta: { journeyId: journey.id, days: policy.checkInDays, count: created.count },
    });
    logger.info(
      `Scheduled ${created.count} check-in(s) for journey ${journey.id} (day ${policy.checkInDays.join("/")})`,
    );
  }
  return created.count;
}

/// Drop the check-ins that haven't gone out yet — used when the surgery date is
/// corrected, so the schedule can be re-anchored. Already-sent (or hand-completed)
/// check-ins are never touched: they are a record of care that was given.
export async function clearScheduledCheckIns(journeyId: string): Promise<number> {
  const res = await prisma.postSalesCheckIn.deleteMany({
    where: { journeyId, status: { in: ["pending", "failed", "blocked"] } },
  });
  await prisma.postSalesJourney.update({
    where: { id: journeyId },
    data: { checkInsScheduledAt: null },
  });
  return res.count;
}

/// A hard reason a care message can't be automated. These do NOT include the
/// marketing opt-out — that's the whole point of a clinical channel. They DO include
/// the safety flags: a possible minor, a legal-threat freeze or an open complaint is
/// a conversation for a person, not a template.
function automationBlock(lead: {
  deletedAt: Date | null;
  possibleMinor: boolean;
  legalThreatFreeze: boolean;
  complaintOpen: boolean;
  consentClinical: boolean | null;
  hearingImpaired: boolean;
}): string | null {
  if (lead.deletedAt) return "Patient record was deleted";
  if (lead.consentClinical === false) return "Clinical consent withheld — check in by phone or in person";
  if (lead.possibleMinor) return "Possibly a minor — a person must contact the guardian";
  if (lead.legalThreatFreeze) return "Legal-threat freeze — no automated contact";
  if (lead.complaintOpen) return "Open complaint — the consultant should call personally";
  // Not a block: a hearing-impaired patient is exactly who WhatsApp suits best.
  void lead.hearingImpaired;
  return null;
}

export type CheckInTickStats = {
  processed: number;
  sent: number;
  blocked: number;
  deferredClash: number;
  deferredQuiet: number;
  failed: number;
};

/// Push a check-in to a later instant, recording why. Beyond MAX_DEFERRALS it becomes
/// a human task instead of being pushed again.
async function defer(
  id: string,
  until: Date,
  reason: string,
  deferrals: number,
  stats: CheckInTickStats,
  kind: "clash" | "quiet",
): Promise<void> {
  if (deferrals >= MAX_DEFERRALS) {
    await prisma.postSalesCheckIn.update({
      where: { id },
      data: { status: "blocked", blockedReason: `Could not find a clear slot: ${reason}` },
    });
    stats.blocked++;
    return;
  }
  await prisma.postSalesCheckIn.update({
    where: { id },
    data: { scheduledFor: until, deferredReason: reason, deferrals: { increment: 1 } },
  });
  if (kind === "clash") stats.deferredClash++;
  else stats.deferredQuiet++;
}

/// Process one due check-in. `sentToday` is the set of IST day-keys on which this
/// PATIENT has already received (or been scheduled to receive, this tick) a care
/// message — the coordination ledger, shared across all their journeys.
async function processCheckIn(
  row: {
    id: string;
    journeyId: string;
    leadId: string;
    dayOffset: number;
    scheduledFor: Date;
    deferrals: number;
    attempts: number;
  },
  now: Date,
  sentToday: Set<string>,
  stats: CheckInTickStats,
): Promise<void> {
  stats.processed++;
  // Keyed on the day the message would ACTUALLY go out (now), not the day it was
  // scheduled for — otherwise two check-ins that fell overdue on different days would
  // carry different keys and both fire this morning, which is the exact clash the
  // coordination rule exists to prevent.
  const dayKey = `${row.leadId}:${istDayKey(now)}`;

  // ── The coordination rule: one care message per patient per IST day. ──
  // Rows are processed in ascending dayOffset, so the clinically closer check-in
  // claims the day and the other is pushed to tomorrow at the normal send hour.
  if (sentToday.has(dayKey)) {
    const tomorrow = istSendInstant(now, 1, sendHour());
    await defer(
      row.id,
      tomorrow,
      "Another care message for this patient was already going out that day",
      row.deferrals,
      stats,
      "clash",
    );
    return;
  }

  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: row.journeyId },
    select: {
      id: true,
      quoteId: true,
      branchId: true,
      quote: { select: { treatment: true } },
      lead: {
        select: {
          id: true,
          name: true,
          deletedAt: true,
          possibleMinor: true,
          legalThreatFreeze: true,
          complaintOpen: true,
          consentClinical: true,
          hearingImpaired: true,
        },
      },
    },
  });
  if (!journey) {
    // The journey vanished under us (quote deleted) — nothing to check in about.
    await prisma.postSalesCheckIn.update({
      where: { id: row.id },
      data: { status: "skipped", note: "Journey no longer exists" },
    });
    return;
  }

  // ── Hard blocks → a task for a person, never a silent drop. ──
  const blocked = automationBlock(journey.lead);
  if (blocked) {
    await prisma.postSalesCheckIn.update({
      where: { id: row.id },
      data: { status: "blocked", blockedReason: blocked },
    });
    await writeAudit({
      action: "postsales.checkin.blocked",
      entityType: "quote",
      entityId: journey.quoteId,
      newValue: `day ${row.dayOffset}`,
      reason: blocked,
      meta: { journeyId: journey.id, leadId: row.leadId, checkInId: row.id },
    });
    stats.blocked++;
    return;
  }

  // ── Quiet hours: a care message still shouldn't arrive at 11pm. ──
  const branch = journey.branchId
    ? await prisma.branch.findUnique({
        where: { id: journey.branchId },
        select: { quietStartHour: true, quietEndHour: true },
      })
    : null;
  const window = resolveQuietWindow(branch?.quietStartHour, branch?.quietEndHour);
  if (isWithinQuietHours(window, now)) {
    await defer(row.id, nextAfterQuietHours(window, now), "Branch quiet hours", row.deferrals, stats, "quiet");
    return;
  }

  // ── Send. The template is per day-offset; unset = can't automate → task. ──
  const template = checkInTemplate(row.dayOffset);
  const res = await sendAutomatedTemplate(
    row.leadId,
    template,
    [firstName(journey.lead.name), journey.quote.treatment, `day ${row.dayOffset}`],
    { clinical: true },
  );

  if (res.ok) {
    await prisma.postSalesCheckIn.update({
      where: { id: row.id },
      data: {
        status: "sent",
        sentAt: now,
        messageId: res.messageId,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    // Claim the day so a sibling journey's check-in doesn't pile on.
    sentToday.add(dayKey);
    await writeAudit({
      action: "postsales.checkin.sent",
      entityType: "quote",
      entityId: journey.quoteId,
      newValue: `day ${row.dayOffset}`,
      meta: { journeyId: journey.id, leadId: row.leadId, checkInId: row.id, messageId: res.messageId },
    });
    stats.sent++;
    return;
  }

  // Nothing was attempted (no template / not configured / consent refusal at the
  // send layer) — retrying won't help until a human acts on it.
  if (!res.sent) {
    await prisma.postSalesCheckIn.update({
      where: { id: row.id },
      data: { status: "blocked", blockedReason: res.reason },
    });
    stats.blocked++;
    logger.warn(`Check-in ${row.id} (day ${row.dayOffset}) blocked: ${res.reason}`);
    return;
  }

  // A real send failure — retry a couple of times, then hand it to a person.
  const attempts = row.attempts + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await prisma.postSalesCheckIn.update({
    where: { id: row.id },
    data: {
      status: giveUp ? "failed" : "pending",
      attempts,
      lastError: res.reason,
      // Back off a few hours before the next attempt (still the same IST day where
      // possible, so the schedule doesn't drift).
      scheduledFor: giveUp ? row.scheduledFor : new Date(now.getTime() + 3 * 60 * 60 * 1000),
    },
  });
  if (giveUp) stats.failed++;
  logger.warn(`Check-in ${row.id} (day ${row.dayOffset}) send failed (attempt ${attempts}): ${res.reason}`);
}

/// One pass of the check-in engine: send every care message that is due, coordinated
/// so no patient gets two on the same day. Called on an interval by the worker.
/// Never throws — each row is isolated, so one bad record can't stall the rest.
export async function runCheckInTick(now: Date = new Date()): Promise<CheckInTickStats> {
  const stats: CheckInTickStats = {
    processed: 0,
    sent: 0,
    blocked: 0,
    deferredClash: 0,
    deferredQuiet: 0,
    failed: 0,
  };
  if (!checkInsEnabled()) return stats;

  const due = await prisma.postSalesCheckIn.findMany({
    where: { status: { in: ["pending", "failed"] }, scheduledFor: { lte: now } },
    // Ascending day-offset FIRST: when two journeys collide on one patient's day, the
    // clinically closer check-in (day 1 beats day 30) claims it and the other moves.
    orderBy: [{ dayOffset: "asc" }, { scheduledFor: "asc" }],
    take: TICK_BATCH,
    select: {
      id: true,
      journeyId: true,
      leadId: true,
      dayOffset: true,
      scheduledFor: true,
      deferrals: true,
      attempts: true,
    },
  });
  if (due.length === 0) return stats;

  // Seed the coordination ledger with care messages ALREADY sent in the last 24h, so a
  // worker restart mid-morning can't double up on a patient. Keys are IST day-stamped,
  // so a message sent late yesterday contributes yesterday's key and doesn't block today.
  const sentToday = new Set<string>();
  const already = await prisma.postSalesCheckIn.findMany({
    where: {
      status: "sent",
      sentAt: { gte: new Date(now.getTime() - DAY_MS) },
      leadId: { in: due.map((d) => d.leadId) },
    },
    select: { leadId: true, sentAt: true },
  });
  for (const a of already) {
    if (a.sentAt) sentToday.add(`${a.leadId}:${istDayKey(a.sentAt)}`);
  }

  for (const row of due) {
    await processCheckIn(row, now, sentToday, stats).catch((err) =>
      logger.error(`Check-in ${row.id} (journey ${row.journeyId}) failed this tick: ${String(err)}`),
    );
  }
  if (stats.processed > 0) logger.info(`Post-sales check-in tick: ${JSON.stringify(stats)}`);
  return stats;
}

/// Mark a check-in done by hand / skipped, from the journey page. This is how a
/// `blocked` check-in gets closed out: the consultant phoned the patient instead.
export async function resolveCheckIn(input: {
  checkInId: string;
  status: "done_manually" | "skipped";
  note?: string | null;
  actor?: { id?: string | null; email?: string | null };
}): Promise<void> {
  const row = await prisma.postSalesCheckIn.findUnique({
    where: { id: input.checkInId },
    select: { id: true, dayOffset: true, journey: { select: { id: true, quoteId: true } } },
  });
  if (!row) throw new Error("Check-in not found");

  await prisma.postSalesCheckIn.update({
    where: { id: row.id },
    data: {
      status: input.status,
      note: input.note?.trim().slice(0, 500) || null,
      completedById: input.actor?.id ?? null,
      sentAt: input.status === "done_manually" ? new Date() : null,
    },
  });
  await writeAudit({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    action: input.status === "skipped" ? "postsales.checkin.skip" : "postsales.checkin.manual",
    entityType: "quote",
    entityId: row.journey.quoteId,
    newValue: `day ${row.dayOffset}`,
    reason: input.note?.trim() || null,
    meta: { journeyId: row.journey.id, checkInId: row.id },
  });
}

/// Re-date a check-in by hand (the patient asked to be contacted later). Keeps
/// `originalFor` so the UI can still show when it was meant to happen.
export async function rescheduleCheckIn(input: {
  checkInId: string;
  scheduledFor: Date;
  actor?: { id?: string | null; email?: string | null };
}): Promise<void> {
  const row = await prisma.postSalesCheckIn.findUnique({
    where: { id: input.checkInId },
    select: { id: true, dayOffset: true, status: true, journey: { select: { id: true, quoteId: true } } },
  });
  if (!row) throw new Error("Check-in not found");
  if (row.status === "sent" || row.status === "done_manually") {
    throw new Error("That check-in has already happened.");
  }

  await prisma.postSalesCheckIn.update({
    where: { id: row.id },
    data: {
      scheduledFor: input.scheduledFor,
      // Re-dating by hand clears an automation block: the consultant has decided
      // when it should go, so let the engine try again then.
      status: "pending",
      blockedReason: null,
      deferredReason: "Rescheduled by staff",
      attempts: 0,
      lastError: null,
    },
  });
  await writeAudit({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    action: "postsales.checkin.reschedule",
    entityType: "quote",
    entityId: row.journey.quoteId,
    field: `day ${row.dayOffset}`,
    newValue: input.scheduledFor.toISOString(),
    meta: { journeyId: row.journey.id, checkInId: row.id },
  });
}
