// Appointments that stopped fitting (§2.9 — doctor availability and leave sync).
//
// When a doctor goes on leave, their roster changes, a one-off change moves them, a
// visiting doctor's contract ends, or a machine goes down, some EXISTING appointments
// may no longer be possible. This module finds them and puts each on the "needs
// rebooking" worklist with an owner and a due date. It never cancels or moves an
// appointment by itself (2.9 "the system never silently cancels").
//
// "Doesn't fit" is decided by the same engine that books: each appointment is
// re-evaluated in place, with its own resources, ignoring itself. Anything that would
// now be refused is a conflict, and the engine's message is the reason.
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { notifyUser } from "@/lib/notifications";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { writeAudit } from "@/lib/audit";
import { evaluateSlot, type Issue } from "@/lib/scheduling/engine";
import {
  findSlots as findSlotsForBranch,
  loadDayContext,
  loadToggles,
  rescheduleAppointment,
  searchChainAvailability,
  type Actor,
} from "@/lib/scheduling/booking";
import { istDateKey, istInstant, MINUTE_MS } from "@/lib/scheduling/time";
import { messagePatient } from "@/lib/scheduling/notify";

export type ConflictCause = "leave" | "emergency" | "roster" | "exception" | "downtime" | "contract" | "closure";

/// Statuses an appointment can be in and still need a doctor/room in the future.
const LIVE = ["tentative", "booked", "confirmed"];

/// Does this appointment still fit? Null = yes; otherwise the blocking issues.
export async function appointmentProblems(appointmentId: string): Promise<Issue[] | null> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { type: { include: { requirements: true } }, resources: { where: { blocking: true }, select: { resourceId: true, endAt: true } } },
  });
  if (!a || !LIVE.includes(a.status)) return null;
  const toggles = await loadToggles();
  const ids = a.resources.map((r) => r.resourceId);
  const ctx = await loadDayContext(prisma, a.branchId, istDateKey(a.startAt), ids, toggles);
  const holdUntil = a.resources.reduce((m, r) => (r.endAt > m ? r.endAt : m), a.endAt);
  const result = evaluateSlot(ctx, {
    startAt: a.startAt,
    endAt: a.endAt,
    holdUntil,
    // Re-check what it HOLDS, not what its type would pick today: the question is
    // whether these people/rooms can still do it.
    requirements: [],
    chosenIds: ids,
    ignoreAppointmentIds: [a.id],
    allowPast: true,
  });
  const blocks = result.issues.filter((i) => i.severity === "block" && i.code !== "outside_hours" && i.code !== "branch_closed" && i.code !== "closure");
  // Branch hours / holidays are left out here on purpose: this check is about the
  // people and rooms an appointment holds. A closure added over existing bookings is
  // caught when it's added (detectClosure).
  return blocks.length ? blocks : null;
}

/// Find live appointments for this resource between from and to that no longer fit,
/// and open a rebooking case for each one that doesn't already have an open case.
export async function detectConflicts(params: {
  resourceId: string;
  from: Date;
  to: Date;
  cause: ConflictCause;
  timeOffId?: string | null;
  urgent?: boolean;
  actor?: Actor;
}): Promise<{ opened: number; appointmentIds: string[] }> {
  const rows = await prisma.appointmentResource.findMany({
    where: {
      resourceId: params.resourceId,
      blocking: true,
      startAt: { lt: params.to },
      endAt: { gt: params.from < new Date() ? new Date() : params.from },
      appointment: { status: { in: LIVE } },
    },
    select: { appointmentId: true },
  });
  const ids = [...new Set(rows.map((r) => r.appointmentId))];
  let opened = 0;
  const affected: string[] = [];
  for (const id of ids) {
    const problems = await appointmentProblems(id);
    if (!problems) continue;
    affected.push(id);
    if (await openCase(id, params.cause, problems[0].message, { timeOffId: params.timeOffId, urgent: params.urgent })) opened++;
  }
  if (opened) {
    logger.info(`Rebooking: ${opened} case(s) opened for resource ${params.resourceId} (${params.cause})`);
    await writeAudit({
      actorId: params.actor?.id ?? null,
      actorEmail: params.actor?.email ?? null,
      action: "appointment.rebooking.detect",
      entityType: "resource",
      entityId: params.resourceId,
      newValue: `${opened} appointment(s) need rebooking`,
      meta: { cause: params.cause, appointmentIds: affected, timeOffId: params.timeOffId ?? null },
    });
  }
  return { opened, appointmentIds: affected };
}

/// A holiday / blackout added over dates that already have bookings (§3.2 1.C): every
/// live appointment inside it goes on the rebooking list. branchId null = all branches.
export async function detectClosure(params: {
  branchId: string | null;
  startDateKey: string;
  endDateKey: string;
  startMin: number | null;
  endMin: number | null;
  reason: string;
  actor?: Actor;
}): Promise<number> {
  const from = istInstant(params.startDateKey, 0);
  const to = istInstant(params.endDateKey, 24 * 60);
  const appts = await prisma.appointment.findMany({
    where: {
      status: { in: LIVE },
      startAt: { gte: from < new Date() ? new Date() : from, lt: to },
      ...(params.branchId ? { branchId: params.branchId } : {}),
    },
    select: { id: true, startAt: true, endAt: true },
  });
  let opened = 0;
  for (const a of appts) {
    if (params.startMin !== null && params.endMin !== null) {
      const dayKey = istDateKey(a.startAt);
      const cs = istInstant(dayKey, params.startMin);
      const ce = istInstant(dayKey, params.endMin);
      if (!(a.startAt < ce && cs < a.endAt)) continue; // part-day closure misses it
    }
    if (await openCase(a.id, "closure", `Branch closed: ${params.reason}`, {})) opened++;
  }
  if (opened) {
    await writeAudit({
      actorId: params.actor?.id ?? null,
      actorEmail: params.actor?.email ?? null,
      action: "appointment.rebooking.detect",
      entityType: "branch",
      entityId: params.branchId,
      newValue: `${opened} appointment(s) need rebooking`,
      meta: { cause: "closure", reason: params.reason },
    });
  }
  return opened;
}

/// Re-check a resource over the coming window (roster edits, one-off changes, contract
/// dates). 90 days covers anything a front desk would have booked.
export async function detectForResource(resourceId: string, cause: ConflictCause, actor?: Actor) {
  const from = new Date();
  const to = new Date(from.getTime() + 90 * 86_400_000);
  const res = await detectConflicts({ resourceId, from, to, cause, actor });
  await recheckOpenCases({ resourceId });
  return res;
}

/// When is a case due? Two days before the appointment, so there's time to reach the
/// patient — or two hours from now if the appointment is sooner than that.
function dueFor(start: Date): { dueAt: Date; urgent: boolean } {
  const now = Date.now();
  const twoDaysBefore = start.getTime() - 48 * 60 * MINUTE_MS;
  const urgent = start.getTime() - now < 24 * 60 * MINUTE_MS;
  return { dueAt: new Date(Math.max(Math.min(twoDaysBefore, start.getTime()), now + 2 * 60 * MINUTE_MS)), urgent };
}

async function openCase(
  appointmentId: string,
  cause: ConflictCause,
  reason: string,
  opts: { timeOffId?: string | null; urgent?: boolean },
): Promise<boolean> {
  const existing = await prisma.rebookingCase.findFirst({
    where: { appointmentId, status: { in: ["open", "proposed", "patient_declined"] } },
    select: { id: true },
  });
  if (existing) return false;
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { startAt: true, branchId: true, branch: { select: { managerId: true, name: true } }, lead: { select: { name: true } } },
  });
  if (!a) return false;
  const due = dueFor(a.startAt);
  await prisma.rebookingCase.create({
    data: {
      appointmentId,
      cause,
      reason,
      timeOffId: opts.timeOffId ?? null,
      branchId: a.branchId,
      ownerId: a.branch.managerId,
      dueAt: due.dueAt,
      urgent: !!opts.urgent || due.urgent,
    },
  });
  if (a.branch.managerId) {
    await notifyUser({
      userId: a.branch.managerId,
      kind: "appointment_rebooking",
      title: `Needs rebooking: ${a.lead.name}`,
      body: `${reason} — ${a.branch.name}`,
      href: "/appointments/rebooking",
      dedupeKey: `rebook:${appointmentId}:${cause}`,
    });
  }
  return true;
}

/// Close cases whose appointment fits again (leave cancelled / rejected, roster put
/// back) or is no longer live (cancelled, completed, moved).
export async function recheckOpenCases(where: { resourceId?: string; timeOffId?: string }): Promise<number> {
  // "proposed" cases are deliberately left alone: the original appointment was moved
  // on purpose and the case now waits for a person to confirm with the patient.
  const cases = await prisma.rebookingCase.findMany({
    where: {
      status: { in: ["open", "patient_declined"] },
      ...(where.timeOffId ? { timeOffId: where.timeOffId } : {}),
      ...(where.resourceId ? { appointment: { resources: { some: { resourceId: where.resourceId } } } } : {}),
    },
    select: { id: true, appointmentId: true, appointment: { select: { status: true } } },
  });
  let closed = 0;
  for (const c of cases) {
    if (!LIVE.includes(c.appointment.status)) {
      await prisma.rebookingCase.update({
        where: { id: c.id },
        data: { status: "resolved", resolvedAt: new Date(), resolutionNote: `Appointment is now ${c.appointment.status.replace("_", " ")}` },
      });
      closed++;
      continue;
    }
    if (!(await appointmentProblems(c.appointmentId))) {
      await prisma.rebookingCase.update({
        where: { id: c.id },
        data: { status: "dismissed", resolvedAt: new Date(), resolutionNote: "No longer conflicts" },
      });
      closed++;
    }
  }
  return closed;
}

// ── Rebooking helper (2.9) ───────────────────────────────────────────────────

export type RebookOption = {
  kind: "same_doctor_later" | "other_doctor_same_time" | "same_doctor_other_branch";
  label: string;
  branchId: string;
  branchName: string;
  doctorId: string | null;
  doctorName: string | null;
  startAt: string;
};

/// Suggested alternatives for one case: the same doctor on their next free day here,
/// another doctor here at the same time, and the same doctor at another branch.
export async function suggestAlternatives(caseId: string): Promise<RebookOption[]> {
  const c = await prisma.rebookingCase.findUnique({
    where: { id: caseId },
    include: {
      appointment: {
        include: {
          branch: { select: { id: true, name: true } },
          type: { include: { requirements: true } },
          resources: { include: { resource: { select: { id: true, name: true, kind: true } } } },
        },
      },
    },
  });
  if (!c) return [];
  const a = c.appointment;
  const doctor = a.resources.find((r) => r.resource.kind === "doctor")?.resource ?? null;
  const options: RebookOption[] = [];
  const startKey = istDateKey(a.startAt);

  // 1. Same doctor, same branch, next free slots (from the appointment's day onward).
  for (let i = 0; i <= 21 && options.filter((o) => o.kind === "same_doctor_later").length < 3; i++) {
    const dateKey = istDateKey(new Date(istInstant(startKey, 12 * 60).getTime() + i * 86_400_000));
    if (dateKey < istDateKey(new Date())) continue;
    const slots = await findSlotsForBranch({
      branchId: a.branchId,
      typeId: a.typeId,
      dateKey,
      resourceIds: doctor ? [doctor.id] : [],
      excludeNeedsAck: true,
    });
    for (const s of slots) {
      if (s.startAt <= new Date()) continue;
      // Prefer the same time of day as the original.
      options.push({
        kind: "same_doctor_later",
        label: `${doctor?.name ?? "Same team"} — next free here`,
        branchId: a.branchId,
        branchName: a.branch.name,
        doctorId: doctor?.id ?? null,
        doctorName: doctor?.name ?? null,
        startAt: s.startAt.toISOString(),
      });
      break; // one per day
    }
  }

  // 2. Another doctor at the same branch, same time.
  if (doctor && a.type.requirements.some((r) => r.kind === "doctor" && !r.resourceId)) {
    const others = await prisma.resource.findMany({ where: { kind: "doctor", active: true, id: { not: doctor.id } }, select: { id: true, name: true } });
    const toggles = await loadToggles();
    for (const o of others) {
      const ctx = await loadDayContext(prisma, a.branchId, startKey, [o.id, ...(await branchResourceIds(a.branchId))], toggles);
      const hold = a.resources.reduce((m, r) => (r.endAt > m ? r.endAt : m), a.endAt);
      const r = evaluateSlot(ctx, {
        startAt: a.startAt,
        endAt: a.endAt,
        holdUntil: hold,
        requirements: a.type.requirements.map((q) => ({ kind: q.kind as "doctor", subtype: q.subtype, resourceId: q.resourceId, quantity: q.quantity })),
        chosenIds: [o.id],
        ignoreAppointmentIds: [a.id],
      });
      if (r.ok && !r.needsAck) {
        options.push({
          kind: "other_doctor_same_time",
          label: `${o.name} — same time`,
          branchId: a.branchId,
          branchName: a.branch.name,
          doctorId: o.id,
          doctorName: o.name,
          startAt: a.startAt.toISOString(),
        });
      }
    }
  }

  // 3. Same doctor, another branch — earliest there.
  if (doctor) {
    const chain = await searchChainAvailability({ typeId: a.typeId, doctorId: doctor.id, dateKey: startKey < istDateKey(new Date()) ? istDateKey(new Date()) : startKey, perBranch: 1 });
    if (chain.ok) {
      for (const b of chain.branches.filter((x) => x.branchId !== a.branchId).slice(0, 2)) {
        options.push({
          kind: "same_doctor_other_branch",
          label: `${doctor.name} at ${b.branchName}`,
          branchId: b.branchId,
          branchName: b.branchName,
          doctorId: doctor.id,
          doctorName: doctor.name,
          startAt: b.slots[0].startAt,
        });
      }
    }
  }
  return options;
}

async function branchResourceIds(branchId: string): Promise<string[]> {
  const rows = await prisma.resource.findMany({
    where: { OR: [{ branchId }, { branchId: null, kind: "staff" }, { kind: "staff", schedules: { some: { branchId } } }] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/// Apply a chosen alternative: reschedule (a new row, linked to the old), mark the
/// case proposed, and tell the patient — "reply if this doesn't work" (2.9 example).
export async function applyAlternative(
  caseId: string,
  option: { branchId: string; doctorId: string | null; startAt: string },
  actor: Actor,
): Promise<{ ok: boolean; error?: string; info?: string; issues?: Issue[] }> {
  const c = await prisma.rebookingCase.findUnique({
    where: { id: caseId },
    include: { appointment: { include: { branch: { select: { name: true } }, resources: { include: { resource: { select: { name: true, kind: true } } } } } } },
  });
  if (!c) return { ok: false, error: "Case not found" };
  if (!["open", "patient_declined"].includes(c.status)) return { ok: false, error: "This case is already being handled" };
  const r = await rescheduleAppointment(
    c.appointmentId,
    {
      startAt: new Date(option.startAt),
      branchId: option.branchId,
      resourceIds: option.doctorId ? [option.doctorId] : undefined,
      reason: `Rebooked: ${c.reason}`,
    },
    actor,
  );
  if (!r.ok) return { ok: false, error: r.error, issues: r.issues };

  const moved = await prisma.appointment.findUnique({
    where: { id: r.appointmentId },
    include: { branch: { select: { name: true } }, resources: { include: { resource: { select: { name: true, kind: true } } } } },
  });
  const oldDoctor = c.appointment.resources.find((x) => x.resource.kind === "doctor")?.resource.name;
  const newDoctor = moved?.resources.find((x) => x.resource.kind === "doctor")?.resource.name;
  const text =
    `${oldDoctor ? `${oldDoctor} is unavailable on ${fmt.format(c.appointment.startAt).split(",")[0]}. ` : ""}` +
    `Your appointment has been moved to ${moved ? fmt.format(moved.startAt) : option.startAt} at ${moved?.branch.name ?? ""}` +
    `${newDoctor && newDoctor !== oldDoctor ? ` with ${newDoctor}` : ""}. Reply if this doesn't work for you.`;
  const sent = await messagePatient(r.appointmentId, text, actor.id ?? null);

  await prisma.rebookingCase.update({
    where: { id: caseId },
    data: {
      status: "proposed",
      newAppointmentId: r.appointmentId,
      resolvedById: actor.id ?? null,
      patientNotifiedAt: sent.sent ? new Date() : null,
      resolutionNote: sent.sent ? "Patient told on WhatsApp" : (sent.reason ?? "Call the patient"),
    },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "appointment.rebooking.apply",
    entityType: "appointment",
    entityId: c.appointmentId,
    newValue: r.appointmentId,
    reason: c.reason,
    meta: { caseId, patientNotified: sent.sent },
  });
  return { ok: true, info: sent.sent ? "Moved — patient told on WhatsApp" : `Moved — ${sent.reason}` };
}

/// Close out a case by hand: confirmed with the patient, dismissed, or "patient
/// declined — call required".
export async function setCaseStatus(
  caseId: string,
  status: "resolved" | "dismissed" | "patient_declined",
  note: string | null,
  actor: Actor,
): Promise<{ ok: boolean; error?: string }> {
  const c = await prisma.rebookingCase.findUnique({ where: { id: caseId }, select: { status: true, appointmentId: true } });
  if (!c) return { ok: false, error: "Case not found" };
  if (["resolved", "dismissed"].includes(c.status)) return { ok: false, error: "Already closed" };
  if (status === "dismissed" && !note?.trim()) return { ok: false, error: "Say why it's being dismissed" };
  await prisma.rebookingCase.update({
    where: { id: caseId },
    data: {
      status,
      resolutionNote: note?.trim() || null,
      ...(status === "patient_declined" ? {} : { resolvedAt: new Date(), resolvedById: actor.id ?? null }),
    },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "appointment.rebooking.status",
    entityType: "appointment",
    entityId: c.appointmentId,
    oldValue: c.status,
    newValue: status,
    reason: note?.trim() || null,
    meta: { caseId },
  });
  return { ok: true };
}

// ── Escalation (2.9 "an unresolved conflict close to the appointment escalates") ──

/// Open cases past their due time escalate once: the owner, every admin and the sales
/// head get a bell entry, and Slack hears about it. Run by the worker.
export async function escalateOverdueCases(now = new Date()): Promise<number> {
  const due = await prisma.rebookingCase.findMany({
    where: { status: { in: ["open", "patient_declined"] }, dueAt: { lte: now }, escalatedAt: null },
    include: { appointment: { select: { startAt: true, lead: { select: { name: true } }, branch: { select: { name: true } } } } },
  });
  if (!due.length) return 0;
  const leaders = await prisma.user.findMany({ where: { role: { in: ["crm_admin", "sales_head"] } }, select: { id: true } });
  for (const c of due) {
    const title = `Overdue rebooking: ${c.appointment.lead.name}`;
    const body = `${c.reason} — ${c.appointment.branch.name}, ${fmt.format(c.appointment.startAt)}`;
    const recipients = new Set([...(c.ownerId ? [c.ownerId] : []), ...leaders.map((l) => l.id)]);
    for (const userId of recipients) {
      await notifyUser({ userId, kind: "appointment_rebooking", title, body, href: "/appointments/rebooking", dedupeKey: `rebook-esc:${c.id}:${userId}` });
    }
    await prisma.rebookingCase.update({ where: { id: c.id }, data: { escalatedAt: now } });
  }
  if (isSlackConfigured()) {
    await sendSlack({ text: `⏰ ${due.length} appointment(s) still need rebooking and are past due — see /appointments/rebooking` }).catch(() => undefined);
  }
  return due.length;
}

/// Emergency same-day unavailability (2.9.d): admins and the sales head hear about it
/// at once, in the app and on Slack.
export async function alertEmergency(resourceName: string, affected: number, actor: Actor): Promise<void> {
  const leaders = await prisma.user.findMany({ where: { role: { in: ["crm_admin", "sales_head"] } }, select: { id: true } });
  const title = `Emergency: ${resourceName} unavailable`;
  const body = affected ? `${affected} appointment(s) need rebooking now` : "No booked appointments affected";
  for (const l of leaders) {
    await notifyUser({ userId: l.id, kind: "appointment_rebooking", title, body, href: "/appointments/rebooking" });
  }
  if (isSlackConfigured()) {
    await sendSlack({ text: `🚨 ${title} — ${body}. Marked by ${actor.email ?? "staff"}.` }).catch(() => undefined);
  }
}
