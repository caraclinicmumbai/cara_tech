// Booking, rescheduling and status changes (§3.2) — the only code that writes
// appointments. Everything goes through here so the double-booking guarantee holds
// no matter which screen (front desk, call centre, online link, series generator)
// made the request.
//
// THE GUARANTEE. Two receptionists can click the same OT slot in the same second.
// Checking "is it free?" and then inserting would let both through. So every write:
//   1. opens a transaction,
//   2. takes a Postgres advisory lock on EVERY resource that could be involved
//      (sorted, so two bookings can't deadlock waiting on each other),
//   3. reloads the day's bookings inside the lock and runs the engine,
//   4. inserts, then commits — releasing the locks.
// A second booking for the same resource waits at step 2, then sees the first one's
// rows at step 3 and is refused. Under READ COMMITTED each statement sees rows
// committed before it began, which is exactly what the post-lock reload needs.
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getBoolSetting, getNumberSetting } from "@/lib/settings";
import {
  SCHEDULING_ENABLED,
  ALLOW_DOCTOR_DOUBLE_BOOKING,
  ENFORCE_BRANCH_HOURS,
  ENFORCE_STAFF_ROSTERS,
  REQUIRE_SUPPORT_STAFF,
  BLOCK_EQUIPMENT,
  DEFAULT_TRAVEL_MINUTES,
} from "@/lib/scheduling/toggles";
import {
  evaluateSlot,
  explainDay,
  findSlots as engineFindSlots,
  type DayContext,
  type EngineResource,
  type EngineToggles,
  type Issue,
  type Requirement,
  type SlotOption,
} from "@/lib/scheduling/engine";
import { branchDay } from "@/lib/scheduling/hours";
import { dateColumn, istDateKey, istInstant, weekdayOfKey, MINUTE_MS } from "@/lib/scheduling/time";
import type { SlotResult } from "@/lib/scheduling/engine";
import {
  canTransition,
  isAppointmentStatus,
  isResourceKind,
  RELEASES_RESOURCES,
  RESCHEDULABLE,
  STATUS_STAMP,
  type AppointmentSource,
  type AppointmentStatus,
} from "@/lib/scheduling/status";

type Db = PrismaClient | Prisma.TransactionClient;

export type Actor = { id?: string | null; email?: string | null };

export type BookingResult =
  | { ok: true; appointmentId: string; warnings: Issue[] }
  | { ok: false; error: string; issues?: Issue[]; needsAck?: boolean; overridable?: boolean; justTaken?: boolean };

export async function schedulingEnabled(): Promise<boolean> {
  return getBoolSetting(SCHEDULING_ENABLED);
}

export async function loadToggles(): Promise<EngineToggles> {
  const [allowDoctorDoubleBooking, enforceBranchHours, enforceStaffRosters, requireSupportStaff, blockEquipment] =
    await Promise.all([
      getBoolSetting(ALLOW_DOCTOR_DOUBLE_BOOKING),
      getBoolSetting(ENFORCE_BRANCH_HOURS),
      getBoolSetting(ENFORCE_STAFF_ROSTERS),
      getBoolSetting(REQUIRE_SUPPORT_STAFF),
      getBoolSetting(BLOCK_EQUIPMENT),
    ]);
  return { allowDoctorDoubleBooking, enforceBranchHours, enforceStaffRosters, requireSupportStaff, blockEquipment };
}

/// Every resource that could take part in a booking at this branch: its own rooms and
/// equipment, every doctor and staff member who isn't pinned to a DIFFERENT branch
/// (or who is rostered here regardless), plus anything named explicitly.
async function candidateResourceIds(db: Db, branchId: string, extraIds: string[]): Promise<string[]> {
  const rows = await db.resource.findMany({
    where: {
      OR: [
        { branchId },
        { branchId: null, kind: { in: ["doctor", "staff"] } },
        { kind: { in: ["doctor", "staff"] }, schedules: { some: { branchId } } },
        ...(extraIds.length ? [{ id: { in: extraIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return [...new Set(rows.map((r) => r.id))].sort();
}

/// Load everything the engine needs for one branch on one IST day.
export async function loadDayContext(
  db: Db,
  branchId: string,
  dateKey: string,
  resourceIds: string[],
  toggles: EngineToggles,
): Promise<DayContext> {
  const dayStart = istInstant(dateKey, 0);
  const dayEnd = istInstant(dateKey, 24 * 60);
  const weekday = weekdayOfKey(dateKey);

  const [{ open, closures }, resources, busyRows, travel] = await Promise.all([
    branchDay(db, branchId, dateKey),
    db.resource.findMany({
      where: { id: { in: resourceIds } },
      include: {
        schedules: { select: { branchId: true, weekday: true, startMin: true, endMin: true } },
        exceptions: { where: { date: dateColumn(dateKey) }, select: { branchId: true, startMin: true, endMin: true } },
        timeOff: { where: { startAt: { lt: dayEnd }, endAt: { gt: dayStart }, status: { in: ["approved", "requested"] } } },
      },
    }),
    db.appointmentResource.findMany({
      where: { resourceId: { in: resourceIds }, blocking: true, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      select: { resourceId: true, appointmentId: true, startAt: true, endAt: true, appointment: { select: { branchId: true } } },
    }),
    loadTravel(db),
  ]);
  const busy = busyRows.map((b) => ({
    resourceId: b.resourceId,
    appointmentId: b.appointmentId,
    branchId: b.appointment.branchId,
    startAt: b.startAt,
    endAt: b.endAt,
  }));

  const map = new Map<string, EngineResource>();
  for (const r of resources) {
    if (!isResourceKind(r.kind)) continue;
    map.set(r.id, {
      id: r.id,
      kind: r.kind,
      subtype: r.subtype,
      name: r.name,
      branchId: r.branchId,
      active: r.active,
      sortOrder: r.sortOrder,
      allowOverride: r.kind === "room" && r.allowOverride,
      // A one-off change for this date replaces the weekly roster for the day (§2.2).
      hasRoster: r.schedules.length > 0 || r.exceptions.length > 0,
      rosterHere: (r.exceptions.length
        ? r.exceptions.filter((e) => e.branchId === branchId)
        : r.schedules.filter((s) => s.branchId === branchId && s.weekday === weekday)
      ).map((s) => ({ startMin: s.startMin, endMin: s.endMin })),
      timeOff: r.timeOff.map((t) => ({ startAt: t.startAt, endAt: t.endAt, reason: t.reason, tentative: t.status === "requested" })),
      contractFrom: r.availableFrom ? r.availableFrom.toISOString().slice(0, 10) : null,
      contractUntil: r.availableUntil ? r.availableUntil.toISOString().slice(0, 10) : null,
    });
  }
  return {
    branchId,
    dateKey,
    open,
    closures,
    resources: map,
    busy,
    toggles,
    travelMinutes: travel.minutes,
    branchNames: travel.names,
  };
}

/// The travel matrix (§2.2.a): explicit pairs, else the default. Same branch = 0.
export async function loadTravel(db: Db): Promise<{ minutes: (a: string, b: string) => number; names: Map<string, string> }> {
  const [rows, branches, fallback] = await Promise.all([
    db.branchTravelTime.findMany({ select: { branchAId: true, branchBId: true, minutes: true } }),
    db.branch.findMany({ select: { id: true, name: true } }),
    getNumberSetting(DEFAULT_TRAVEL_MINUTES),
  ]);
  const pairs = new Map(rows.map((r) => [travelKey(r.branchAId, r.branchBId), r.minutes]));
  return {
    minutes: (a, b) => (a === b ? 0 : (pairs.get(travelKey(a, b)) ?? fallback)),
    names: new Map(branches.map((b) => [b.id, b.name])),
  };
}

export function travelKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

async function lockResources(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
  for (const id of [...ids].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sched:" + id}))`;
  }
}

async function typeWithRequirements(db: Db, typeId: string) {
  const type = await db.appointmentType.findUnique({ where: { id: typeId }, include: { requirements: true } });
  if (!type) return null;
  const requirements: Requirement[] = type.requirements
    .filter((r) => isResourceKind(r.kind))
    .map((r) => ({
      kind: r.kind as Requirement["kind"],
      subtype: r.subtype,
      resourceId: r.resourceId,
      quantity: Math.max(1, r.quantity),
    }));
  return { type, requirements };
}

export type BookingInput = {
  leadId: string;
  branchId: string;
  typeId: string;
  startAt: Date;
  /// Override the type's duration (a long consultation). Null = the type's default.
  durationMin?: number | null;
  resourceIds?: string[];
  notes?: string | null;
  source?: AppointmentSource;
  /// The person booking has seen and accepted the overbooked-doctor warning.
  acknowledgeWarnings?: boolean;
  /// Create as a tentative hold (online booking) that lapses after `holdMinutes`.
  holdMinutes?: number | null;
  allowPast?: boolean;
  /// An online hold (§2.3): placed BEFORE the patient is known, so it's held against
  /// the hidden placeholder lead (onlineHoldLeadId) and moved to the real patient when
  /// they verify their phone. Requires holdMinutes.
  onlineHold?: boolean;
  /// Book over a clash on a consultation room (§2.1.c). The CALLER must have checked
  /// `appointments.override`; a reason is required and recorded.
  override?: { reason: string } | null;
  quoteId?: string | null;
  journeyId?: string | null;
};

/// The one hidden lead every online hold is parked on until the patient is known
/// (§2.3). Soft-deleted, so it never appears in a list, a report or a call queue.
export async function onlineHoldLeadId(): Promise<string> {
  const existing = await prisma.lead.findFirst({ where: { externalId: "system:online-hold", source: "web_form" }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.lead.create({
    data: {
      name: "Online booking (slot held)",
      phone: "+910000000000",
      source: "web_form",
      externalId: "system:online-hold",
      status: "manual_followup",
      deletedAt: new Date(),
      deletedBy: "system",
    },
    select: { id: true },
  });
  return created.id;
}

/// Reminders follow the appointment (§2.4): best-effort, after the commit, and never
/// able to fail the booking itself. Imported lazily — reminders.ts imports this file.
async function remindersAfter(action: "booked" | "moved" | "ended", appointmentId: string, oldId?: string) {
  try {
    const r = await import("@/lib/scheduling/reminders");
    if (action === "booked") await r.scheduleReminders(appointmentId);
    else if (action === "moved") {
      if (oldId) await r.cancelReminders(oldId, "Appointment moved");
      await r.scheduleReminders(appointmentId, { skipOnBooking: true });
    } else await r.cancelReminders(appointmentId, "Appointment ended or cancelled");
  } catch (err) {
    logger.error(`Reminder scheduling for ${appointmentId} failed: ${String(err)}`);
  }
}

/// Treatment plans follow the appointment too (§2.8): a booking may start a plan, a
/// move carries the plan's steps (and shifts it if it's the anchor), a completion or
/// cancellation updates the step. Same rules: after the commit, never failing it.
async function seriesAfter(
  e: { kind: "booked"; id: string } | { kind: "moved"; oldId: string; newId: string } | { kind: "status"; id: string; to: string },
  actor: Actor,
) {
  try {
    const series = await import("@/lib/scheduling/series");
    if (e.kind === "booked") await series.autoStartFor(e.id);
    else if (e.kind === "moved") await series.onAppointmentMoved(e.oldId, e.newId, actor);
    else await series.onAppointmentStatus(e.id, e.to, actor);
  } catch (err) {
    logger.error(`Treatment plan update failed: ${String(err)}`);
  }
}

/// Turn a refused evaluation into the answer the form needs. `before` is the same
/// evaluation run BEFORE taking the locks: if that was fine and the locked one isn't,
/// somebody else booked those resources in the meantime — say so plainly (§2.1 "the
/// other is told the slot was just taken") rather than listing a clash the person
/// booking never saw.
function refusal(result: SlotResult, before: SlotResult | null, ack: string): BookingResult {
  const blocks = result.issues.filter((i) => i.severity === "block");
  if (blocks.length && before?.ok) {
    return { ok: false, error: "That slot was just taken by another booking — please pick another time.", issues: result.issues, justTaken: true };
  }
  if (blocks.length) {
    return { ok: false, error: blocks[0].message, issues: result.issues, overridable: result.overridable };
  }
  return { ok: false, error: ack, issues: result.issues, needsAck: true };
}

/// What would happen if this were booked — the same evaluation booking runs, without
/// writing or locking. For the booking form to show warnings before the click.
export async function previewBooking(input: BookingInput) {
  const t = await typeWithRequirements(prisma, input.typeId);
  if (!t) return { ok: false as const, error: "Unknown appointment type" };
  const toggles = await loadToggles();
  const duration = input.durationMin ?? t.type.durationMin;
  const endAt = new Date(input.startAt.getTime() + duration * MINUTE_MS);
  const holdUntil = new Date(endAt.getTime() + t.type.bufferAfterMin * MINUTE_MS);
  const dateKey = istDateKey(input.startAt);
  const ids = await candidateResourceIds(prisma, input.branchId, input.resourceIds ?? []);
  const ctx = await loadDayContext(prisma, input.branchId, dateKey, ids, toggles);
  return {
    ok: true as const,
    endAt,
    result: evaluateSlot(ctx, {
      startAt: input.startAt,
      endAt,
      holdUntil,
      requirements: t.requirements,
      chosenIds: input.resourceIds ?? [],
      allowPast: input.allowPast,
    }),
  };
}

/// Book an appointment. Refuses on any block; refuses an un-acknowledged
/// overbooked-doctor warning with `needsAck: true` so the form can ask.
export async function bookAppointment(input: BookingInput, actor: Actor): Promise<BookingResult> {
  if (!(await schedulingEnabled())) return { ok: false, error: "The appointments module is switched off" };

  const t = await typeWithRequirements(prisma, input.typeId);
  if (!t) return { ok: false, error: "Unknown appointment type" };
  if (!t.type.active) return { ok: false, error: `${t.type.name} is no longer bookable` };
  if (input.onlineHold && !input.holdMinutes) return { ok: false, error: "An online hold needs a hold time" };
  const lead = input.onlineHold
    ? { id: await onlineHoldLeadId() }
    : await prisma.lead.findFirst({ where: { id: input.leadId, deletedAt: null }, select: { id: true } });
  if (!lead) return { ok: false, error: "Patient not found" };

  const toggles = await loadToggles();
  const duration = input.durationMin ?? t.type.durationMin;
  if (!Number.isInteger(duration) || duration < 5 || duration > 24 * 60) return { ok: false, error: "Invalid duration" };
  const endAt = new Date(input.startAt.getTime() + duration * MINUTE_MS);
  const holdUntil = new Date(endAt.getTime() + t.type.bufferAfterMin * MINUTE_MS);
  const dateKey = istDateKey(input.startAt);
  const chosen = input.resourceIds ?? [];
  const overrideReason = input.override?.reason?.trim() || null;
  if (input.override && !overrideReason) return { ok: false, error: "An override needs a reason" };
  const slot = {
    startAt: input.startAt,
    endAt,
    holdUntil,
    requirements: t.requirements,
    chosenIds: chosen,
    allowPast: input.allowPast,
    override: !!overrideReason,
  };

  try {
    // Unlocked first look — only used to tell "just taken" apart from "never free".
    const preIds = await candidateResourceIds(prisma, input.branchId, chosen);
    const before = evaluateSlot(await loadDayContext(prisma, input.branchId, dateKey, preIds, toggles), slot);

    const outcome = await prisma.$transaction(async (tx) => {
      const ids = await candidateResourceIds(tx, input.branchId, chosen);
      await lockResources(tx, ids);
      const ctx = await loadDayContext(tx, input.branchId, dateKey, ids, toggles);
      const result = evaluateSlot(ctx, slot);
      if (!result.ok) return { ok: false as const, result };
      if (result.needsAck && !input.acknowledgeWarnings) return { ok: false as const, result };

      const hold = input.holdMinutes ? new Date(Date.now() + input.holdMinutes * MINUTE_MS) : null;
      const appt = await tx.appointment.create({
        data: {
          leadId: lead.id,
          branchId: input.branchId,
          typeId: input.typeId,
          startAt: input.startAt,
          endAt,
          status: hold ? "tentative" : "booked",
          source: input.source ?? "front_desk",
          notes: input.notes?.trim() || null,
          bookedById: actor.id ?? null,
          holdExpiresAt: hold,
          doctorOverbooked: result.issues.some((i) => i.code === "doctor_overbooked"),
          ...(result.issues.some((i) => i.code === "room_overridden")
            ? { overrideReason, overriddenById: actor.id ?? null }
            : {}),
          quoteId: input.quoteId ?? null,
          journeyId: input.journeyId ?? null,
          resources: {
            create: result.resourceIds.map((resourceId) => ({ resourceId, startAt: input.startAt, endAt: holdUntil })),
          },
        },
        select: { id: true },
      });
      return { ok: true as const, id: appt.id, result };
    });

    if (!outcome.ok) return refusal(outcome.result, before, "Please confirm the warnings to book");

    const overridden = outcome.result.issues.filter((i) => i.code === "room_overridden");
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: overridden.length ? "appointment.book.override" : "appointment.book",
      reason: overridden.length ? overrideReason : null,
      entityType: "appointment",
      entityId: outcome.id,
      newValue: `${t.type.name} @ ${input.startAt.toISOString()}`,
      meta: {
        leadId: input.leadId,
        branchId: input.branchId,
        resourceIds: outcome.result.resourceIds,
        source: input.source ?? "front_desk",
        warningsAcknowledged: outcome.result.issues.filter((i) => i.severity === "warn").map((i) => i.message),
      },
    });
    if (!input.holdMinutes) {
      await remindersAfter("booked", outcome.id);
      await seriesAfter({ kind: "booked", id: outcome.id }, actor);
    }
    return { ok: true, appointmentId: outcome.id, warnings: outcome.result.issues };
  } catch (err) {
    logger.error(`bookAppointment failed: ${String(err)}`);
    return { ok: false, error: "Could not book the appointment" };
  }
}

export type RescheduleInput = {
  startAt: Date;
  branchId?: string;
  durationMin?: number | null;
  resourceIds?: string[];
  acknowledgeWarnings?: boolean;
  reason?: string | null;
  allowPast?: boolean;
};

/// Move an appointment. The old row is kept as `rescheduled` and a new row links back
/// to it — the history is the chain (§3.2 1.E), never an overwritten time.
export async function rescheduleAppointment(id: string, input: RescheduleInput, actor: Actor): Promise<BookingResult> {
  if (!(await schedulingEnabled())) return { ok: false, error: "The appointments module is switched off" };

  const old = await prisma.appointment.findUnique({
    where: { id },
    include: { resources: { where: { blocking: true }, select: { resourceId: true, resource: { select: { kind: true } } } } },
  });
  if (!old) return { ok: false, error: "Appointment not found" };
  if (!RESCHEDULABLE.includes(old.status as AppointmentStatus)) {
    return { ok: false, error: `A ${old.status.replace("_", " ")} appointment can't be rescheduled` };
  }
  const t = await typeWithRequirements(prisma, old.typeId);
  if (!t) return { ok: false, error: "Unknown appointment type" };

  const branchId = input.branchId ?? old.branchId;
  const toggles = await loadToggles();
  const duration = input.durationMin ?? Math.round((old.endAt.getTime() - old.startAt.getTime()) / MINUTE_MS);
  const endAt = new Date(input.startAt.getTime() + duration * MINUTE_MS);
  const holdUntil = new Date(endAt.getTime() + t.type.bufferAfterMin * MINUTE_MS);
  // Keep the patient's chosen SURGEON (§2.1.d) unless told otherwise; everything else —
  // rooms, the OT team, machines — is re-allocated from scratch for the new time
  // (§2.1 "rescheduling never assumes the old resources are still valid").
  const chosen = input.resourceIds ?? old.resources.filter((r) => r.resource.kind === "doctor").map((r) => r.resourceId);
  const dateKey = istDateKey(input.startAt);

  try {
    const rescheduleSlot = {
      startAt: input.startAt,
      endAt,
      holdUntil,
      requirements: t.requirements,
      chosenIds: chosen,
      ignoreAppointmentIds: [id], // its own current slot is about to be freed
      allowPast: input.allowPast,
    };
    const preIds = await candidateResourceIds(prisma, branchId, chosen);
    const before = evaluateSlot(await loadDayContext(prisma, branchId, dateKey, preIds, toggles), rescheduleSlot);

    const outcome = await prisma.$transaction(async (tx) => {
      const ids = await candidateResourceIds(tx, branchId, chosen);
      await lockResources(tx, ids);
      const fresh = await tx.appointment.findUnique({ where: { id }, select: { status: true } });
      if (!fresh || !RESCHEDULABLE.includes(fresh.status as AppointmentStatus)) {
        return { ok: false as const, result: null, error: "The appointment changed while you were editing it" };
      }
      const ctx = await loadDayContext(tx, branchId, dateKey, ids, toggles);
      const result = evaluateSlot(ctx, rescheduleSlot);
      if (!result.ok || (result.needsAck && !input.acknowledgeWarnings)) return { ok: false as const, result };

      const now = new Date();
      await tx.appointment.update({
        where: { id },
        data: { status: "rescheduled", statusChangedAt: now, cancelReason: input.reason?.trim() || null },
      });
      await tx.appointmentResource.updateMany({ where: { appointmentId: id }, data: { blocking: false } });
      const next = await tx.appointment.create({
        data: {
          leadId: old.leadId,
          branchId,
          typeId: old.typeId,
          startAt: input.startAt,
          endAt,
          // A confirmed patient who agreed to the new time stays confirmed only if they
          // confirm again — the new slot starts as booked.
          status: "booked",
          source: old.source,
          notes: old.notes,
          bookedById: actor.id ?? null,
          doctorOverbooked: result.issues.some((i) => i.code === "doctor_overbooked"),
          rescheduledFromId: id,
          quoteId: old.quoteId,
          journeyId: old.journeyId,
          resources: {
            create: result.resourceIds.map((resourceId) => ({ resourceId, startAt: input.startAt, endAt: holdUntil })),
          },
        },
        select: { id: true },
      });
      return { ok: true as const, id: next.id, result };
    });

    if (!outcome.ok) {
      if (!outcome.result) return { ok: false, error: "The appointment changed while you were editing it" };
      return refusal(outcome.result, before, "Please confirm the warnings to reschedule");
    }

    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "appointment.reschedule",
      entityType: "appointment",
      entityId: id,
      field: "startAt",
      oldValue: old.startAt.toISOString(),
      newValue: input.startAt.toISOString(),
      reason: input.reason?.trim() || null,
      meta: { newAppointmentId: outcome.id, branchId, resourceIds: outcome.result.resourceIds },
    });
    await remindersAfter("moved", outcome.id, id);
    await seriesAfter({ kind: "moved", oldId: id, newId: outcome.id }, actor);
    return { ok: true, appointmentId: outcome.id, warnings: outcome.result.issues };
  } catch (err) {
    logger.error(`rescheduleAppointment failed: ${String(err)}`);
    return { ok: false, error: "Could not reschedule the appointment" };
  }
}

/// Move an appointment along its lifecycle (check in, start, complete, cancel,
/// no-show, confirm). Cancelling needs a reason and who called it off.
export async function changeAppointmentStatus(
  id: string,
  to: string,
  opts: { reason?: string | null; cancelledBy?: "patient" | "clinic" | null },
  actor: Actor,
): Promise<{ ok: boolean; error?: string }> {
  if (!(await schedulingEnabled())) return { ok: false, error: "The appointments module is switched off" };
  if (!isAppointmentStatus(to)) return { ok: false, error: "Unknown status" };
  if (to === "rescheduled") return { ok: false, error: "Use reschedule to move an appointment" };
  const reason = opts.reason?.trim() || null;
  if (to === "cancelled" && (!reason || !opts.cancelledBy)) {
    return { ok: false, error: "Cancelling needs a reason and who cancelled" };
  }

  const appt = await prisma.appointment.findUnique({ where: { id }, select: { status: true } });
  if (!appt) return { ok: false, error: "Appointment not found" };
  if (!canTransition(appt.status, to)) {
    return { ok: false, error: `Can't move from ${appt.status.replace("_", " ")} to ${to.replace("_", " ")}` };
  }

  const now = new Date();
  const stamp = STATUS_STAMP[to];
  try {
    // Guard on the status we read, so two people changing it at once can't both apply.
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.appointment.updateMany({
        where: { id, status: appt.status },
        data: {
          status: to,
          statusChangedAt: now,
          ...(stamp ? { [stamp]: now } : {}),
          ...(to === "cancelled" ? { cancelReason: reason, cancelledBy: opts.cancelledBy } : {}),
          ...(to === "booked" ? { confirmedAt: null, holdExpiresAt: null } : {}),
        },
      });
      if (res.count === 1 && RELEASES_RESOURCES.includes(to)) {
        await tx.appointmentResource.updateMany({ where: { appointmentId: id }, data: { blocking: false } });
      }
      return res.count === 1;
    });
    if (!updated) return { ok: false, error: "The appointment changed while you were editing it" };

    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "appointment.status",
      entityType: "appointment",
      entityId: id,
      field: "status",
      oldValue: appt.status,
      newValue: to,
      reason,
      meta: opts.cancelledBy ? { cancelledBy: opts.cancelledBy } : null,
    });
    if (["cancelled", "no_show", "completed", "checked_in", "in_progress"].includes(to)) await remindersAfter("ended", id);
    else if (appt.status === "tentative" && to === "booked") {
      await remindersAfter("booked", id);
      await seriesAfter({ kind: "booked", id }, actor);
    }
    if (["completed", "cancelled", "no_show"].includes(to)) await seriesAfter({ kind: "status", id, to }, actor);
    return { ok: true };
  } catch (err) {
    logger.error(`changeAppointmentStatus failed: ${String(err)}`);
    return { ok: false, error: "Could not update the appointment" };
  }
}

/// Lapse tentative holds whose time is up (§3.2 1.5 "expires in ~5–10 min"), freeing
/// their resources. Called by the worker; safe to run any time.
export async function expireHolds(now = new Date()): Promise<number> {
  const due = await prisma.appointment.findMany({
    where: { status: "tentative", holdExpiresAt: { lte: now } },
    select: { id: true },
  });
  let n = 0;
  for (const { id } of due) {
    const res = await changeAppointmentStatus(id, "cancelled", { reason: "Hold expired", cancelledBy: "patient" }, {});
    if (res.ok) n++;
  }
  return n;
}

/// Workable start times for a type on one day at one branch.
export async function findSlots(params: {
  branchId: string;
  typeId: string;
  dateKey: string;
  resourceIds?: string[];
  stepMin?: number;
  excludeNeedsAck?: boolean;
  /// Treat this appointment as not there — when moving it.
  ignoreAppointmentIds?: string[];
}): Promise<SlotOption[]> {
  const t = await typeWithRequirements(prisma, params.typeId);
  if (!t) return [];
  const toggles = await loadToggles();
  const ids = await candidateResourceIds(prisma, params.branchId, params.resourceIds ?? []);
  const ctx = await loadDayContext(prisma, params.branchId, params.dateKey, ids, toggles);
  return engineFindSlots(ctx, {
    durationMin: t.type.durationMin,
    bufferAfterMin: t.type.bufferAfterMin,
    requirements: t.requirements,
    chosenIds: params.resourceIds ?? [],
    stepMin: params.stepMin,
    excludeNeedsAck: params.excludeNeedsAck,
    ignoreAppointmentIds: params.ignoreAppointmentIds,
    istInstant,
  });
}

export type DayAvailability = {
  dateKey: string;
  slots: { startAt: string; endAt: string; needsAck: boolean; warnings: string[] }[];
  /// Why nothing is offered, when nothing is (§2.1 "shows the front desk why").
  reasons: string[];
};

/// Find a slot (§2.1 worked example): the requested day — its slots, or why there are
/// none — and, when it has none, the next day within `searchDays` that does.
export async function searchAvailability(params: {
  branchId: string;
  typeId: string;
  dateKey: string;
  doctorId?: string | null;
  stepMin?: number;
  searchDays?: number;
}): Promise<{ ok: true; requested: DayAvailability; next: DayAvailability | null } | { ok: false; error: string }> {
  const t = await typeWithRequirements(prisma, params.typeId);
  if (!t) return { ok: false, error: "Unknown appointment type" };
  const needsDoctor = t.requirements.some((r) => r.kind === "doctor" && !r.resourceId);
  if (needsDoctor && !params.doctorId) return { ok: false, error: "Choose the doctor — patients book a specific surgeon" };

  const toggles = await loadToggles();
  const chosen = params.doctorId ? [params.doctorId] : [];
  const ids = await candidateResourceIds(prisma, params.branchId, chosen);
  const opts = {
    durationMin: t.type.durationMin,
    bufferAfterMin: t.type.bufferAfterMin,
    requirements: t.requirements,
    chosenIds: chosen,
    stepMin: params.stepMin ?? 15,
    istInstant,
  };

  const day = async (dateKey: string): Promise<DayAvailability> => {
    const ctx = await loadDayContext(prisma, params.branchId, dateKey, ids, toggles);
    const slots = engineFindSlots(ctx, opts);
    return {
      dateKey,
      slots: slots.map((s) => ({
        startAt: s.startAt.toISOString(),
        endAt: s.endAt.toISOString(),
        needsAck: s.needsAck,
        warnings: s.warnings.filter((w) => w.severity === "warn").map((w) => w.message),
      })),
      reasons: slots.length ? [] : explainDay(ctx, opts),
    };
  };

  const requested = await day(params.dateKey);
  if (requested.slots.length) return { ok: true, requested, next: null };

  const start = istInstant(params.dateKey, 12 * 60);
  for (let i = 1; i <= (params.searchDays ?? 14); i++) {
    const d = await day(istDateKey(new Date(start.getTime() + i * 86_400_000)));
    if (d.slots.length) return { ok: true, requested, next: d };
  }
  return { ok: true, requested, next: null };
}

export type BranchEarliest = { branchId: string; branchName: string; dateKey: string; slots: DayAvailability["slots"] };

/// Chain view search (§2.2 worked example): "Dr Asif — Consultation, as soon as
/// possible, anywhere." For every active branch, the first day within `searchDays`
/// that has a slot, with its first few start times — sorted by the earliest slot, so
/// the call centre reads the answer off the top.
export async function searchChainAvailability(params: {
  typeId: string;
  doctorId?: string | null;
  dateKey: string;
  searchDays?: number;
  perBranch?: number;
}): Promise<{ ok: true; branches: BranchEarliest[] } | { ok: false; error: string }> {
  const t = await typeWithRequirements(prisma, params.typeId);
  if (!t) return { ok: false, error: "Unknown appointment type" };
  const needsDoctor = t.requirements.some((r) => r.kind === "doctor" && !r.resourceId);
  if (needsDoctor && !params.doctorId) return { ok: false, error: "Choose the doctor — patients book a specific surgeon" };

  const toggles = await loadToggles();
  const chosen = params.doctorId ? [params.doctorId] : [];
  const branches = await prisma.branch.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const opts = {
    durationMin: t.type.durationMin,
    bufferAfterMin: t.type.bufferAfterMin,
    requirements: t.requirements,
    chosenIds: chosen,
    stepMin: 15,
    istInstant,
  };
  const start = istInstant(params.dateKey, 12 * 60);
  const out: BranchEarliest[] = [];

  for (const b of branches) {
    const ids = await candidateResourceIds(prisma, b.id, chosen);
    for (let i = 0; i <= (params.searchDays ?? 14); i++) {
      const dateKey = istDateKey(new Date(start.getTime() + i * 86_400_000));
      const ctx = await loadDayContext(prisma, b.id, dateKey, ids, toggles);
      // A branch the doctor isn't rostered at on this day can't have a slot — skip the
      // slot walk (the common case for a rotating surgeon).
      const doc = params.doctorId ? ctx.resources.get(params.doctorId) : null;
      if (doc && doc.hasRoster && doc.rosterHere.length === 0) continue;
      const slots = engineFindSlots(ctx, opts);
      if (!slots.length) continue;
      out.push({
        branchId: b.id,
        branchName: b.name,
        dateKey,
        slots: slots.slice(0, params.perBranch ?? 6).map((s) => ({
          startAt: s.startAt.toISOString(),
          endAt: s.endAt.toISOString(),
          needsAck: s.needsAck,
          warnings: s.warnings.filter((w) => w.severity === "warn").map((w) => w.message),
        })),
      });
      break;
    }
  }
  out.sort((x, y) => x.slots[0].startAt.localeCompare(y.slots[0].startAt));
  return { ok: true, branches: out };
}
