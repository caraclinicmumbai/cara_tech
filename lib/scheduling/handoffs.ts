// Appointments → the modules that don't exist yet (spec §3, decision 3.a: "prepare the
// hand-off"). Our side of each integration, so EMR, Inventory, HR and Assets plug in
// instead of rewiring the calendar:
//
//   3.3 EMR        check-in opens an ENCOUNTER (who was seen, by whom, when, with which
//                  intake form); completing the visit closes it.
//   3.5 Inventory  an appointment type lists its CONSUMABLES; confirming the appointment
//                  raises a reservation request, which is released if the visit is
//                  cancelled, missed or moved and consumed when it is completed. No stock
//                  is counted here.
//   3.8 HR         approved leave arrives over a feed (`upsertExternalTimeOff`, source "hr")
//                  and becomes the same blocking time off that leave entered by hand is.
//   3.9 Assets     maintenance / calibration downtime arrives the same way (source "assets").
//   3.8 / 3.9 out  `utilisation()` — per doctor: visits completed, no-shows, hours booked,
//                  by type; per machine: uses and hours — for commission and service intervals.
//
// Best-effort where it follows an appointment change: a hand-off hiccup never blocks the
// visit itself.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { Actor } from "@/lib/scheduling/booking";
import { detectConflicts, recheckOpenCases } from "@/lib/scheduling/conflicts";

// ── After an appointment changes ─────────────────────────────────────────────

export async function handoffsAfterStatus(input: { appointmentId: string; from: string; to: string }): Promise<void> {
  const { appointmentId, from, to } = input;
  try {
    if (to === "checked_in") await openEncounter(appointmentId);
    else if (to === "completed") await closeEncounter(appointmentId);
    else if (to === "cancelled" && from === "checked_in") {
      await prisma.encounter.updateMany({ where: { appointmentId, status: "open" }, data: { status: "cancelled", closedAt: new Date() } });
    }

    if (to === "confirmed") await reserveConsumables(appointmentId);
    else if (to === "completed") await settleConsumables(appointmentId, "consumed");
    else if (to === "cancelled" || to === "no_show") await settleConsumables(appointmentId, "released");
  } catch (err) {
    logger.error(`handoffsAfterStatus failed for appointment ${appointmentId}: ${String(err)}`);
  }
}

/// A moved appointment gives its reservation back; the new slot asks again when it is
/// confirmed (a move starts the new row as `booked`).
export async function handoffsAfterMove(oldId: string): Promise<void> {
  await settleConsumables(oldId, "released").catch((err) => logger.error(`release after move failed: ${String(err)}`));
}

async function openEncounter(appointmentId: string): Promise<void> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      leadId: true,
      branchId: true,
      resources: { select: { resource: { select: { id: true, kind: true } } } },
      intakeResponses: { orderBy: { submittedAt: "desc" }, take: 1, select: { id: true } },
    },
  });
  if (!a) return;
  await prisma.encounter.upsert({
    where: { appointmentId },
    create: {
      appointmentId,
      leadId: a.leadId,
      branchId: a.branchId,
      doctorId: a.resources.find((r) => r.resource.kind === "doctor")?.resource.id ?? null,
      intakeResponseId: a.intakeResponses[0]?.id ?? null,
    },
    update: {},
  });
}

async function closeEncounter(appointmentId: string): Promise<void> {
  const r = await prisma.encounter.updateMany({ where: { appointmentId, status: "open" }, data: { status: "closed", closedAt: new Date() } });
  // A visit completed without a check-in (desk shortcut) still was a visit.
  if (r.count === 0 && !(await prisma.encounter.findUnique({ where: { appointmentId }, select: { id: true } }))) {
    await openEncounter(appointmentId);
    await prisma.encounter.updateMany({ where: { appointmentId }, data: { status: "closed", closedAt: new Date() } });
  }
}

async function reserveConsumables(appointmentId: string): Promise<void> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { type: { select: { consumables: true } } },
  });
  const items = a?.type.consumables ?? [];
  for (const it of items) {
    await prisma.consumableReservation.upsert({
      where: { appointmentId_sku: { appointmentId, sku: it.sku } },
      create: { appointmentId, sku: it.sku, name: it.name, quantity: it.quantity },
      update: { status: "requested", quantity: it.quantity, name: it.name },
    });
  }
}

async function settleConsumables(appointmentId: string, status: "released" | "consumed"): Promise<void> {
  await prisma.consumableReservation.updateMany({ where: { appointmentId, status: "requested" }, data: { status } });
}

// ── In: leave (HR) and downtime (Assets) ─────────────────────────────────────

export type ExternalTimeOff = {
  source: "hr" | "assets";
  /// The feeding system's id for this absence.
  externalId: string;
  /// Our resource id, or the resource's `externalRef` (employee code / asset tag).
  resource: string;
  startAt: Date;
  endAt: Date;
  /// leave | conference | training | travel | maintenance | calibration | other
  kind?: string;
  reason?: string | null;
  /// approved (blocks) | cancelled (withdraws it)
  status: "approved" | "cancelled";
};

/// Create, move or withdraw an absence from another system. Idempotent on `externalId`.
/// An approved absence is exactly like leave entered by hand: it blocks the calendar and
/// opens rebooking cases for anything already booked (2.9) — existing appointments are
/// never moved or cancelled.
export async function upsertExternalTimeOff(
  input: ExternalTimeOff,
): Promise<{ ok: true; id: string; affected: number; state: "created" | "updated" | "cancelled" | "unchanged" } | { ok: false; error: string }> {
  if (!(input.endAt > input.startAt)) return { ok: false, error: "endAt must be after startAt" };
  const res = await prisma.resource.findFirst({
    where: { OR: [{ id: input.resource }, { externalRef: input.resource }] },
    select: { id: true, name: true, kind: true },
  });
  if (!res) return { ok: false, error: `Unknown resource "${input.resource}" — set its external reference in setup` };
  const kind = input.kind === "calibration" ? "maintenance" : input.kind || (input.source === "assets" ? "maintenance" : "leave");
  const cause = input.source === "assets" ? "downtime" : "leave";
  const actor: Actor = { id: null, email: `${input.source} feed` };
  const existing = await prisma.resourceTimeOff.findUnique({ where: { externalId: input.externalId } });

  if (input.status === "cancelled") {
    if (!existing || existing.status === "cancelled") return { ok: true, id: existing?.id ?? "", affected: 0, state: "unchanged" };
    await prisma.resourceTimeOff.update({ where: { id: existing.id }, data: { status: "cancelled", decidedAt: new Date() } });
    await recheckOpenCases({ timeOffId: existing.id });
    await writeAudit({ ...auditActor(actor), action: "leave.cancel", entityType: "resource", entityId: res.id, newValue: `${res.name} (${input.source} feed)`, meta: { timeOffId: existing.id, externalId: input.externalId } });
    return { ok: true, id: existing.id, affected: 0, state: "cancelled" };
  }

  const same =
    existing &&
    existing.status === "approved" &&
    existing.startAt.getTime() === input.startAt.getTime() &&
    existing.endAt.getTime() === input.endAt.getTime();
  if (same) return { ok: true, id: existing.id, affected: 0, state: "unchanged" };

  const data = {
    resourceId: res.id,
    startAt: input.startAt,
    endAt: input.endAt,
    kind,
    reason: input.reason?.trim() || null,
    status: "approved",
    source: input.source,
    decidedAt: new Date(),
  };
  const row = existing
    ? await prisma.resourceTimeOff.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.resourceTimeOff.create({ data: { ...data, externalId: input.externalId }, select: { id: true } });
  if (existing) await recheckOpenCases({ timeOffId: row.id });
  const d = await detectConflicts({ resourceId: res.id, from: input.startAt, to: input.endAt, cause, timeOffId: row.id, actor });
  await writeAudit({
    ...auditActor(actor),
    action: input.source === "assets" ? "resource.downtime" : "leave.approve",
    entityType: "resource",
    entityId: res.id,
    newValue: `${res.name}: ${input.startAt.toISOString()} – ${input.endAt.toISOString()} (${input.source} feed)`,
    reason: input.reason ?? null,
    meta: { timeOffId: row.id, externalId: input.externalId, affected: d.appointmentIds.length },
  });
  return { ok: true, id: row.id, affected: d.appointmentIds.length, state: existing ? "updated" : "created" };
}

function auditActor(a: Actor) {
  return { actorId: a.id ?? null, actorEmail: a.email ?? null };
}

// ── Out: utilisation (HR commission, Assets service intervals) ───────────────

export type UtilisationRow = {
  resourceId: string;
  externalRef: string | null;
  name: string;
  kind: string;
  /// Appointments that held this resource in the window (not cancelled / moved).
  booked: number;
  completed: number;
  noShows: number;
  /// Hours the resource was booked for (appointment time, without turnover).
  bookedHours: number;
  /// Completed visits by appointment type — "procedures per doctor".
  byType: Record<string, number>;
  /// Machines: completed uses ever, for a service interval counted in uses.
  lifetimeUses?: number;
};

export async function utilisation(params: { from: Date; to: Date; kind?: "doctor" | "equipment" | "staff" | "room" }): Promise<UtilisationRow[]> {
  const rows = await prisma.appointmentResource.findMany({
    where: {
      startAt: { gte: params.from, lt: params.to },
      appointment: { status: { notIn: ["cancelled", "rescheduled", "tentative"] } },
      ...(params.kind ? { resource: { kind: params.kind } } : {}),
    },
    select: {
      resource: { select: { id: true, name: true, kind: true, externalRef: true } },
      appointment: { select: { status: true, startAt: true, endAt: true, type: { select: { name: true } } } },
    },
  });
  const out = new Map<string, UtilisationRow>();
  for (const r of rows) {
    const row =
      out.get(r.resource.id) ??
      ({
        resourceId: r.resource.id,
        externalRef: r.resource.externalRef,
        name: r.resource.name,
        kind: r.resource.kind,
        booked: 0,
        completed: 0,
        noShows: 0,
        bookedHours: 0,
        byType: {},
      } satisfies UtilisationRow);
    row.booked++;
    row.bookedHours += (r.appointment.endAt.getTime() - r.appointment.startAt.getTime()) / 3_600_000;
    if (r.appointment.status === "completed") {
      row.completed++;
      row.byType[r.appointment.type.name] = (row.byType[r.appointment.type.name] ?? 0) + 1;
    } else if (r.appointment.status === "no_show") row.noShows++;
    out.set(r.resource.id, row);
  }
  const result = [...out.values()].map((r) => ({ ...r, bookedHours: Math.round(r.bookedHours * 100) / 100 }));
  const machines = result.filter((r) => r.kind === "equipment");
  if (machines.length) {
    const life = await prisma.appointmentResource.groupBy({
      by: ["resourceId"],
      where: { resourceId: { in: machines.map((m) => m.resourceId) }, appointment: { status: "completed" } },
      _count: { _all: true },
    });
    const byId = new Map(life.map((l) => [l.resourceId, l._count._all]));
    for (const m of machines) m.lifetimeUses = byId.get(m.resourceId) ?? 0;
  }
  return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
