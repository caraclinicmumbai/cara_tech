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
import { getBoolSetting } from "@/lib/settings";
import {
  SCHEDULING_ENABLED,
  ALLOW_DOCTOR_DOUBLE_BOOKING,
  ENFORCE_BRANCH_HOURS,
  ENFORCE_STAFF_ROSTERS,
  REQUIRE_SUPPORT_STAFF,
} from "@/lib/scheduling/toggles";
import {
  evaluateSlot,
  findSlots as engineFindSlots,
  type DayContext,
  type EngineResource,
  type EngineToggles,
  type Issue,
  type Requirement,
  type SlotOption,
} from "@/lib/scheduling/engine";
import { branchDay } from "@/lib/scheduling/hours";
import { istDateKey, istInstant, weekdayOfKey, MINUTE_MS } from "@/lib/scheduling/time";
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
  | { ok: false; error: string; issues?: Issue[]; needsAck?: boolean };

export async function schedulingEnabled(): Promise<boolean> {
  return getBoolSetting(SCHEDULING_ENABLED);
}

export async function loadToggles(): Promise<EngineToggles> {
  const [allowDoctorDoubleBooking, enforceBranchHours, enforceStaffRosters, requireSupportStaff] = await Promise.all([
    getBoolSetting(ALLOW_DOCTOR_DOUBLE_BOOKING),
    getBoolSetting(ENFORCE_BRANCH_HOURS),
    getBoolSetting(ENFORCE_STAFF_ROSTERS),
    getBoolSetting(REQUIRE_SUPPORT_STAFF),
  ]);
  return { allowDoctorDoubleBooking, enforceBranchHours, enforceStaffRosters, requireSupportStaff };
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

  const [{ open, closures }, resources, busy] = await Promise.all([
    branchDay(db, branchId, dateKey),
    db.resource.findMany({
      where: { id: { in: resourceIds } },
      include: {
        schedules: { select: { branchId: true, weekday: true, startMin: true, endMin: true } },
        timeOff: { where: { startAt: { lt: dayEnd }, endAt: { gt: dayStart } } },
      },
    }),
    db.appointmentResource.findMany({
      where: { resourceId: { in: resourceIds }, blocking: true, startAt: { lt: dayEnd }, endAt: { gt: dayStart } },
      select: { resourceId: true, appointmentId: true, startAt: true, endAt: true },
    }),
  ]);

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
      hasRoster: r.schedules.length > 0,
      rosterHere: r.schedules
        .filter((s) => s.branchId === branchId && s.weekday === weekday)
        .map((s) => ({ startMin: s.startMin, endMin: s.endMin })),
      timeOff: r.timeOff.map((t) => ({ startAt: t.startAt, endAt: t.endAt, reason: t.reason })),
    });
  }
  return { branchId, dateKey, open, closures, resources: map, busy, toggles };
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
  quoteId?: string | null;
  journeyId?: string | null;
};

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
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId, deletedAt: null }, select: { id: true } });
  if (!lead) return { ok: false, error: "Patient not found" };

  const toggles = await loadToggles();
  const duration = input.durationMin ?? t.type.durationMin;
  if (!Number.isInteger(duration) || duration < 5 || duration > 24 * 60) return { ok: false, error: "Invalid duration" };
  const endAt = new Date(input.startAt.getTime() + duration * MINUTE_MS);
  const holdUntil = new Date(endAt.getTime() + t.type.bufferAfterMin * MINUTE_MS);
  const dateKey = istDateKey(input.startAt);
  const chosen = input.resourceIds ?? [];

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const ids = await candidateResourceIds(tx, input.branchId, chosen);
      await lockResources(tx, ids);
      const ctx = await loadDayContext(tx, input.branchId, dateKey, ids, toggles);
      const result = evaluateSlot(ctx, {
        startAt: input.startAt,
        endAt,
        holdUntil,
        requirements: t.requirements,
        chosenIds: chosen,
        allowPast: input.allowPast,
      });
      if (!result.ok) return { ok: false as const, result };
      if (result.needsAck && !input.acknowledgeWarnings) return { ok: false as const, result };

      const hold = input.holdMinutes ? new Date(Date.now() + input.holdMinutes * MINUTE_MS) : null;
      const appt = await tx.appointment.create({
        data: {
          leadId: input.leadId,
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

    if (!outcome.ok) {
      const blocks = outcome.result.issues.filter((i) => i.severity === "block");
      return blocks.length
        ? { ok: false, error: blocks[0].message, issues: outcome.result.issues }
        : { ok: false, error: "Please confirm the warnings to book", issues: outcome.result.issues, needsAck: true };
    }

    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "appointment.book",
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
    include: { resources: { where: { blocking: true }, select: { resourceId: true } } },
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
  // Keep the same people/rooms unless told otherwise — "same doctor, Thursday instead".
  const chosen = input.resourceIds ?? old.resources.map((r) => r.resourceId);
  const dateKey = istDateKey(input.startAt);

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const ids = await candidateResourceIds(tx, branchId, chosen);
      await lockResources(tx, ids);
      const fresh = await tx.appointment.findUnique({ where: { id }, select: { status: true } });
      if (!fresh || !RESCHEDULABLE.includes(fresh.status as AppointmentStatus)) {
        return { ok: false as const, result: null, error: "The appointment changed while you were editing it" };
      }
      const ctx = await loadDayContext(tx, branchId, dateKey, ids, toggles);
      const result = evaluateSlot(ctx, {
        startAt: input.startAt,
        endAt,
        holdUntil,
        requirements: t.requirements,
        chosenIds: chosen,
        ignoreAppointmentIds: [id], // its own current slot is about to be freed
        allowPast: input.allowPast,
      });
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
      const blocks = outcome.result.issues.filter((i) => i.severity === "block");
      return blocks.length
        ? { ok: false, error: blocks[0].message, issues: outcome.result.issues }
        : { ok: false, error: "Please confirm the warnings to reschedule", issues: outcome.result.issues, needsAck: true };
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
    istInstant,
  });
}
