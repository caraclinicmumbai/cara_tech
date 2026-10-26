// Doctor availability and leave (§2.9). Entered once, applied everywhere: a leave
// row on the doctor's resource blocks them at EVERY branch the moment it's approved,
// because the engine reads one calendar per person.
//
//   requested → approved (blocks; existing appointments go to "needs rebooking")
//             → rejected | cancelled (re-checks any cases it opened)
//
// 2.9.a: the doctor requests, head office (`appointments.approveLeave`) approves. An
// approver, or an admin entering leave for someone, can create it already approved.
// 2.9.d: emergency same-day — approved at once, cases opened as urgent, admins and the
// sales head alerted.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { notifyUser } from "@/lib/notifications";
import type { Actor } from "@/lib/scheduling/booking";
import { alertEmergency, detectConflicts, recheckOpenCases } from "@/lib/scheduling/conflicts";
import { istDateKey, istInstant } from "@/lib/scheduling/time";

export const LEAVE_KINDS = ["leave", "conference", "training", "travel", "emergency", "other"] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];
export const LEAVE_KIND_LABELS: Record<LeaveKind, string> = {
  leave: "Leave",
  conference: "Conference",
  training: "Training",
  travel: "Travel",
  emergency: "Emergency / sick",
  other: "Other",
};

type Result = { ok: boolean; error?: string; info?: string; id?: string; affected?: number };

/// How many live appointments sit inside a window for this resource — shown to the
/// approver BEFORE they approve, so the cost of a yes is visible.
export async function affectedCount(resourceId: string, startAt: Date, endAt: Date): Promise<number> {
  return prisma.appointmentResource.count({
    where: {
      resourceId,
      blocking: true,
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      appointment: { status: { in: ["tentative", "booked", "confirmed"] } },
    },
  });
}

export async function requestLeave(
  input: { resourceId: string; startAt: Date; endAt: Date; kind: string; reason?: string | null; approveNow?: boolean },
  actor: Actor,
): Promise<Result> {
  if (!(LEAVE_KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: "Pick a leave type" };
  if (!(input.endAt > input.startAt)) return { ok: false, error: "The end must be after the start" };
  const res = await prisma.resource.findUnique({ where: { id: input.resourceId }, select: { name: true, kind: true } });
  if (!res) return { ok: false, error: "Unknown doctor / staff member" };

  const status = input.approveNow ? "approved" : "requested";
  const row = await prisma.resourceTimeOff.create({
    data: {
      resourceId: input.resourceId,
      startAt: input.startAt,
      endAt: input.endAt,
      kind: input.kind,
      reason: input.reason?.trim() || null,
      status,
      source: "manual",
      requestedById: actor.id ?? null,
      createdById: actor.id ?? null,
      ...(input.approveNow ? { decidedById: actor.id ?? null, decidedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: input.approveNow ? "leave.create.approved" : "leave.request",
    entityType: "resource",
    entityId: input.resourceId,
    newValue: `${res.name}: ${input.startAt.toISOString()} – ${input.endAt.toISOString()} (${input.kind})`,
    reason: input.reason?.trim() || null,
    meta: { timeOffId: row.id },
  });

  if (input.approveNow) {
    const d = await detectConflicts({ resourceId: input.resourceId, from: input.startAt, to: input.endAt, cause: "leave", timeOffId: row.id, actor });
    return { ok: true, id: row.id, affected: d.appointmentIds.length, info: summary(d.appointmentIds.length, true) };
  }

  // Tell the approvers.
  const approvers = await prisma.user.findMany({ where: { role: { in: ["crm_admin", "sales_head"] } }, select: { id: true } });
  const n = await affectedCount(input.resourceId, input.startAt, input.endAt);
  for (const a of approvers) {
    await notifyUser({
      userId: a.id,
      kind: "leave_request",
      title: `Leave request: ${res.name}`,
      body: `${istDateKey(input.startAt)} → ${istDateKey(new Date(input.endAt.getTime() - 1))}${n ? ` · ${n} appointment(s) affected` : ""}`,
      href: "/appointments/leave",
      dedupeKey: `leave:${row.id}:${a.id}`,
    });
  }
  return { ok: true, id: row.id, info: "Requested — head office will approve it. Until then, bookings in that time show a warning." };
}

function summary(n: number, approved: boolean): string {
  const head = approved ? "Approved — blocked at every branch." : "Saved.";
  return n ? `${head} ${n} appointment(s) need rebooking — see Needs rebooking.` : `${head} No booked appointments were affected.`;
}

export async function decideLeave(id: string, approve: boolean, note: string | null, actor: Actor): Promise<Result> {
  const row = await prisma.resourceTimeOff.findUnique({ where: { id }, include: { resource: { select: { name: true } } } });
  if (!row) return { ok: false, error: "Leave not found" };
  if (row.status !== "requested") return { ok: false, error: `Already ${row.status}` };
  if (!approve && !note?.trim()) return { ok: false, error: "Say why it's being rejected" };
  await prisma.resourceTimeOff.update({
    where: { id },
    data: { status: approve ? "approved" : "rejected", decidedById: actor.id ?? null, decidedAt: new Date(), decisionNote: note?.trim() || null },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: approve ? "leave.approve" : "leave.reject",
    entityType: "resource",
    entityId: row.resourceId,
    newValue: `${row.resource.name}: ${row.startAt.toISOString()} – ${row.endAt.toISOString()}`,
    reason: note?.trim() || null,
    meta: { timeOffId: id },
  });
  if (row.requestedById) {
    await notifyUser({
      userId: row.requestedById,
      kind: "leave_request",
      title: `Leave ${approve ? "approved" : "rejected"}: ${row.resource.name}`,
      body: note?.trim() || null,
      href: "/appointments/leave",
    });
  }
  if (!approve) return { ok: true, info: "Rejected" };
  const d = await detectConflicts({ resourceId: row.resourceId, from: row.startAt, to: row.endAt, cause: "leave", timeOffId: id, actor });
  return { ok: true, affected: d.appointmentIds.length, info: summary(d.appointmentIds.length, true) };
}

/// Withdraw leave (requested or approved). Cases it opened are re-checked and closed
/// where the appointment fits again.
export async function cancelLeave(id: string, actor: Actor): Promise<Result> {
  const row = await prisma.resourceTimeOff.findUnique({ where: { id }, include: { resource: { select: { name: true } } } });
  if (!row) return { ok: false, error: "Leave not found" };
  if (!["requested", "approved"].includes(row.status)) return { ok: false, error: `Already ${row.status}` };
  await prisma.resourceTimeOff.update({ where: { id }, data: { status: "cancelled", decidedById: actor.id ?? null, decidedAt: new Date() } });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "leave.cancel",
    entityType: "resource",
    entityId: row.resourceId,
    newValue: `${row.resource.name}: ${row.startAt.toISOString()} – ${row.endAt.toISOString()}`,
    meta: { timeOffId: id },
  });
  const closed = await recheckOpenCases({ timeOffId: id });
  return { ok: true, info: closed ? `Cancelled — ${closed} rebooking case(s) closed` : "Cancelled" };
}

/// Emergency same-day (2.9.d): unavailable from `from` (default now) to the end of the
/// IST day. Approved at once; affected appointments become urgent cases; admins and
/// the sales head are alerted immediately.
export async function markEmergency(resourceId: string, reason: string, actor: Actor, from = new Date()): Promise<Result> {
  if (!reason.trim()) return { ok: false, error: "Give a reason (e.g. unwell)" };
  const res = await prisma.resource.findUnique({ where: { id: resourceId }, select: { name: true } });
  if (!res) return { ok: false, error: "Unknown doctor" };
  const endAt = istInstant(istDateKey(from), 24 * 60);
  try {
    const row = await prisma.resourceTimeOff.create({
      data: {
        resourceId,
        startAt: from,
        endAt,
        kind: "emergency",
        reason: reason.trim(),
        status: "approved",
        source: "manual",
        requestedById: actor.id ?? null,
        decidedById: actor.id ?? null,
        decidedAt: new Date(),
        createdById: actor.id ?? null,
      },
      select: { id: true },
    });
    const d = await detectConflicts({ resourceId, from, to: endAt, cause: "emergency", timeOffId: row.id, urgent: true, actor });
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "leave.emergency",
      entityType: "resource",
      entityId: resourceId,
      newValue: `${res.name} unavailable until end of day`,
      reason: reason.trim(),
      meta: { timeOffId: row.id, affected: d.appointmentIds.length },
    });
    await alertEmergency(res.name, d.appointmentIds.length, actor);
    return { ok: true, id: row.id, affected: d.appointmentIds.length, info: summary(d.appointmentIds.length, true) };
  } catch (err) {
    logger.error(`markEmergency failed: ${String(err)}`);
    return { ok: false, error: "Could not mark the emergency" };
  }
}
