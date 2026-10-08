"use server";

// Server Actions for the appointments desk (§3.2 / §2.2). Every write re-checks, on the
// server: the capability, the branch rule (2.2.c — book outside your own branch only
// with `appointments.bookAnyBranch`), and the override capability (2.1.c). The
// booking service underneath enforces the scheduling rules themselves.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability, requireUser } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getBoolSetting } from "@/lib/settings";
import { advanceStage } from "@/lib/leadStages";
import { findLeadByPhone, phoneKey } from "@/lib/messages";
import { toDialable } from "@/lib/phone";
import { PATIENT_FLAGS_ENABLED } from "@/lib/scheduling/toggles";
import {
  bookAppointment,
  changeAppointmentStatus,
  findSlots,
  rescheduleAppointment,
  schedulingEnabled,
  searchAvailability,
  searchChainAvailability,
  type BookingResult,
  type BranchEarliest,
  type DayAvailability,
} from "@/lib/scheduling/booking";
import { mayActAtBranch, viewerFor } from "@/lib/scheduling/calendar";
import { STATUS_TRANSITIONS, isAppointmentStatus } from "@/lib/scheduling/status";
import type { Issue } from "@/lib/scheduling/engine";
import { appointmentLink } from "@/lib/scheduling/links";

const PATH = "/appointments";

// ── Find a slot ──────────────────────────────────────────────────────────────

export type SlotSearchResult =
  | { ok: true; requested: DayAvailability; next: DayAvailability | null }
  | { ok: false; error: string };

export async function searchSlots(params: {
  branchId: string;
  typeId: string;
  doctorId: string;
  dateKey: string;
}): Promise<SlotSearchResult> {
  await requireCapability("appointments.view");
  if (!(await schedulingEnabled())) return { ok: false, error: "The appointments module is switched off" };
  if (!params.branchId || !params.typeId) return { ok: false, error: "Pick a branch and a treatment" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.dateKey)) return { ok: false, error: "Pick a date" };
  try {
    return await searchAvailability({
      branchId: params.branchId,
      typeId: params.typeId,
      doctorId: params.doctorId || null,
      dateKey: params.dateKey,
    });
  } catch (err) {
    logger.error(`searchSlots failed: ${String(err)}`);
    return { ok: false, error: "Could not search for slots" };
  }
}

/// Chain view (§2.2): the earliest slots for this doctor + treatment at every branch.
export async function searchChain(params: {
  typeId: string;
  doctorId: string;
  dateKey: string;
}): Promise<{ ok: true; branches: BranchEarliest[] } | { ok: false; error: string }> {
  await requireCapability("appointments.view");
  if (!(await schedulingEnabled())) return { ok: false, error: "The appointments module is switched off" };
  if (!params.typeId) return { ok: false, error: "Pick a treatment" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.dateKey)) return { ok: false, error: "Pick a date" };
  try {
    return await searchChainAvailability({ typeId: params.typeId, doctorId: params.doctorId || null, dateKey: params.dateKey });
  } catch (err) {
    logger.error(`searchChain failed: ${String(err)}`);
    return { ok: false, error: "Could not search the chain" };
  }
}

// ── Patients ─────────────────────────────────────────────────────────────────

export type PatientHit = { id: string; name: string; phoneTail: string; flags: string[] };

/// Find a patient to book. Deliberately minimal: name and the last four digits of the
/// phone are enough to pick the right person at the desk, and this search ignores
/// the lead-ownership scope — the receptionist booking a patient isn't their
/// counsellor, and shouldn't see the sales record to do it.
export async function searchPatients(q: string): Promise<PatientHit[]> {
  await requireCapability("appointments.book");
  const term = q.trim();
  if (term.length < 2) return [];
  const digits = term.replace(/\D/g, "");
  const rows = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits.slice(-10) } }] : []),
      ],
    },
    take: 12,
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, phone: true, flags: { where: { flag: { active: true } }, select: { flag: { select: { label: true } } } } },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, phoneTail: r.phone.slice(-4), flags: r.flags.map((f) => f.flag.label) }));
}

/// Create a patient at the desk (a phone call, a walk-in). A phone that already exists
/// returns that person instead of a duplicate (§3.1 duplicate detection). Created
/// straight into manual follow-up and never AI-called: they're booking, not enquiring.
export async function createPatient(input: { name: string; phone: string }): Promise<{ ok: boolean; error?: string; patient?: PatientHit; existed?: boolean }> {
  const user = await requireCapability("appointments.book");
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter the patient's name" };
  const dial = toDialable(input.phone);
  if (!dial.ok) return { ok: false, error: "Enter a valid mobile number (10 digits, or +91…)" };
  const phone = dial.e164;
  const existing = await findLeadByPhone(phone);
  if (existing) {
    return { ok: true, existed: true, patient: { id: existing.id, name: existing.name, phoneTail: existing.phone.slice(-4), flags: [] } };
  }
  try {
    const lead = await prisma.lead.create({
      // Stage stays at the default; the booking that follows moves it to
      // "appointment scheduled" (moveLeadToScheduled).
      data: { name, phone, source: "manual", status: "manual_followup" },
      select: { id: true, name: true, phone: true },
    });
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: "lead.create",
      entityType: "lead",
      entityId: lead.id,
      newValue: `${name} (appointments desk)`,
      meta: { phoneKey: phoneKey(phone) },
    });
    return { ok: true, patient: { id: lead.id, name: lead.name, phoneTail: lead.phone.slice(-4), flags: [] } };
  } catch (err) {
    logger.error(`createPatient failed: ${String(err)}`);
    return { ok: false, error: "Could not create the patient" };
  }
}

// ── Booking ──────────────────────────────────────────────────────────────────

export type SlotsForBooking = { startAt: string; endAt: string; needsAck: boolean; warnings: string[] }[];

export async function slotsForBooking(params: {
  branchId: string;
  typeId: string;
  doctorId: string;
  dateKey: string;
}): Promise<SlotsForBooking> {
  await requireCapability("appointments.book");
  if (!params.branchId || !params.typeId || !/^\d{4}-\d{2}-\d{2}$/.test(params.dateKey)) return [];
  const slots = await findSlots({
    branchId: params.branchId,
    typeId: params.typeId,
    dateKey: params.dateKey,
    resourceIds: params.doctorId ? [params.doctorId] : [],
  });
  return slots.map((s) => ({
    startAt: s.startAt.toISOString(),
    endAt: s.endAt.toISOString(),
    needsAck: s.needsAck,
    warnings: s.warnings.filter((w) => w.severity === "warn").map((w) => w.message),
  }));
}

export type DeskResult = {
  ok: boolean;
  error?: string;
  info?: string;
  appointmentId?: string;
  issues?: Issue[];
  needsAck?: boolean;
  overridable?: boolean;
  justTaken?: boolean;
};

function fromBooking(r: BookingResult, info: string): DeskResult {
  if (r.ok) return { ok: true, appointmentId: r.appointmentId, info };
  return { ok: false, error: r.error, issues: r.issues, needsAck: r.needsAck, overridable: r.overridable, justTaken: r.justTaken };
}

export async function bookFromDesk(input: {
  leadId: string;
  branchId: string;
  typeId: string;
  doctorId: string;
  startAt: string;
  notes?: string;
  acknowledgeWarnings?: boolean;
  overrideReason?: string | null;
  source?: "front_desk" | "call_centre";
}): Promise<DeskResult> {
  const user = await requireCapability("appointments.book");
  const viewer = await viewerFor(user);
  if (!mayActAtBranch(viewer, input.branchId)) {
    return { ok: false, error: "You can book at your own branch only — the call centre or a branch manager can book here" };
  }
  if (input.overrideReason && !viewer.canOverride) return { ok: false, error: "Only a branch manager can override a room clash" };
  const startAt = new Date(input.startAt);
  if (Number.isNaN(startAt.getTime())) return { ok: false, error: "Pick a time" };

  const r = await bookAppointment(
    {
      leadId: input.leadId,
      branchId: input.branchId,
      typeId: input.typeId,
      startAt,
      resourceIds: input.doctorId ? [input.doctorId] : [],
      notes: input.notes,
      acknowledgeWarnings: !!input.acknowledgeWarnings,
      override: input.overrideReason ? { reason: input.overrideReason } : null,
      source: input.source ?? (viewer.homeBranchId === input.branchId ? "front_desk" : "call_centre"),
    },
    user,
  );
  if (r.ok) {
    await moveLeadToScheduled(input.leadId, user);
    revalidatePath(PATH);
  }
  return fromBooking(r, "Booked");
}

/// Booking moves the patient's pipeline stage to "Appointment scheduled" — forward
/// only, so a patient further along (consulted, converted) is never pulled back.
async function moveLeadToScheduled(leadId: string, user: { id?: string; email?: string | null }) {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { stage: true } });
    if (!lead) return;
    const next = advanceStage(lead.stage, "appointment_scheduled");
    if (!next) return;
    await prisma.lead.update({ where: { id: leadId }, data: { stage: next, stageChangedAt: new Date(), stageStuckNotifiedAt: null } });
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: "lead.stage.move",
      entityType: "lead",
      entityId: leadId,
      field: "stage",
      oldValue: lead.stage,
      newValue: next,
      reason: "Appointment booked",
    });
  } catch (err) {
    logger.error(`moveLeadToScheduled failed: ${String(err)}`);
  }
}

async function appointmentBranch(id: string): Promise<string | null> {
  const a = await prisma.appointment.findUnique({ where: { id }, select: { branchId: true } });
  return a?.branchId ?? null;
}

export async function rescheduleFromDesk(input: {
  id: string;
  startAt: string;
  doctorId?: string | null;
  reason?: string;
  acknowledgeWarnings?: boolean;
}): Promise<DeskResult> {
  const user = await requireCapability("appointments.book");
  const viewer = await viewerFor(user);
  const branchId = await appointmentBranch(input.id);
  if (!branchId) return { ok: false, error: "Appointment not found" };
  if (!mayActAtBranch(viewer, branchId)) return { ok: false, error: "You can change appointments at your own branch only" };
  const startAt = new Date(input.startAt);
  if (Number.isNaN(startAt.getTime())) return { ok: false, error: "Pick a time" };
  const r = await rescheduleAppointment(
    input.id,
    {
      startAt,
      resourceIds: input.doctorId ? [input.doctorId] : undefined,
      reason: input.reason,
      acknowledgeWarnings: !!input.acknowledgeWarnings,
    },
    user,
  );
  if (r.ok) revalidatePath(PATH);
  return fromBooking(r, "Rescheduled");
}

/// Status moves. Running the day (check in → start → complete, no-show) needs
/// `appointments.checkin`; confirming and cancelling need `appointments.book`.
export async function setAppointmentStatus(input: {
  id: string;
  to: string;
  reason?: string;
  cancelledBy?: "patient" | "clinic";
}): Promise<DeskResult> {
  const user = await requireUser();
  await ensurePermissions();
  const runsTheDay = ["checked_in", "in_progress", "completed", "no_show"].includes(input.to);
  const cap = runsTheDay ? "appointments.checkin" : "appointments.book";
  if (!can(user.role, cap)) return { ok: false, error: "You don't have permission for that" };
  const viewer = await viewerFor(user);
  const appt = await prisma.appointment.findUnique({
    where: { id: input.id },
    select: { branchId: true, resources: { select: { resourceId: true } } },
  });
  if (!appt) return { ok: false, error: "Appointment not found" };
  // A doctor may run their own appointments at any branch; otherwise the branch rule.
  const own = viewer.resourceId !== null && appt.resources.some((r) => r.resourceId === viewer.resourceId);
  if (!own && !mayActAtBranch(viewer, appt.branchId)) return { ok: false, error: "You can change appointments at your own branch only" };
  const r = await changeAppointmentStatus(input.id, input.to, { reason: input.reason, cancelledBy: input.cancelledBy ?? null }, user);
  if (r.ok) revalidatePath(PATH);
  return r;
}

// ── Appointment card ─────────────────────────────────────────────────────────

export type AppointmentDetail = {
  id: string;
  visible: boolean;
  branchId: string;
  branchName: string;
  startAt: string;
  endAt: string;
  status: string;
  nextStatuses: string[];
  typeId: string;
  typeName: string | null;
  patient: { id: string; name: string; phone: string } | null;
  notes: string | null;
  doctor: { id: string; name: string } | null;
  resources: { id: string; name: string; kind: string }[];
  flags: { id: string; label: string; icon: string; tone: string; on: boolean }[];
  flagsEnabled: boolean;
  doctorOverbooked: boolean;
  overrideReason: string | null;
  cancelReason: string | null;
  rescheduledFrom: string | null;
  canAct: boolean;
  canRunDay: boolean;
  canSeeLead: boolean;
  /// §2.4 — what was (or will be) sent, and how each channel went.
  reminders: { id: string; name: string; dueAt: string; status: string; whatsapp: string | null; sms: string | null; email: string | null; note: string | null }[];
  /// The patient's self-service link, for staff to send by hand. Null when not visible.
  patientLink: string | null;
  source: string;
  /// §2.3.b — paid online at booking (so the desk doesn't charge again).
  payment: { status: string; amount: number; discountPct: number } | null;
};

export async function getAppointmentDetail(id: string): Promise<AppointmentDetail | null> {
  const user = await requireCapability("appointments.view");
  const viewer = await viewerFor(user);
  const a = await prisma.appointment.findUnique({
    where: { id },
    include: {
      branch: { select: { name: true } },
      type: { select: { name: true } },
      lead: { select: { id: true, name: true, phone: true, flags: { select: { flagId: true } } } },
      resources: { select: { resource: { select: { id: true, name: true, kind: true } } } },
      rescheduledFrom: { select: { startAt: true } },
      reminders: { orderBy: { dueAt: "asc" }, include: { template: { select: { name: true } } } },
      payments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!a) return null;
  const res = a.resources.map((r) => r.resource);
  const own = viewer.resourceId !== null && res.some((r) => r.id === viewer.resourceId);
  const visible = viewer.seesAllBranches || a.branchId === viewer.homeBranchId || own;
  const flagsEnabled = await getBoolSetting(PATIENT_FLAGS_ENABLED);
  const defs = visible && flagsEnabled ? await prisma.flagDefinition.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }) : [];
  const on = new Set(a.lead.flags.map((f) => f.flagId));
  const doctor = res.find((r) => r.kind === "doctor") ?? null;
  const mayAct = mayActAtBranch(viewer, a.branchId);
  return {
    id: a.id,
    visible,
    branchId: a.branchId,
    branchName: a.branch.name,
    startAt: a.startAt.toISOString(),
    endAt: a.endAt.toISOString(),
    status: a.status,
    nextStatuses: isAppointmentStatus(a.status) ? [...STATUS_TRANSITIONS[a.status]] : [],
    typeId: a.typeId,
    typeName: visible ? a.type.name : null,
    patient: visible ? { id: a.lead.id, name: a.lead.name, phone: a.lead.phone } : null,
    notes: visible ? a.notes : null,
    doctor: doctor ? { id: doctor.id, name: doctor.name } : null,
    resources: res,
    flags: defs.map((d) => ({ id: d.id, label: d.label, icon: d.icon, tone: d.tone, on: on.has(d.id) })),
    flagsEnabled,
    doctorOverbooked: a.doctorOverbooked,
    overrideReason: visible ? a.overrideReason : null,
    cancelReason: visible ? a.cancelReason : null,
    rescheduledFrom: a.rescheduledFrom ? a.rescheduledFrom.startAt.toISOString() : null,
    canAct: visible && viewer.canBook && mayAct,
    canRunDay: visible && viewer.canCheckin && (mayAct || own),
    canSeeLead: visible && can(user.role, "leads.view"),
    reminders: visible
      ? a.reminders.map((r) => ({
          id: r.id,
          name: r.template.name,
          dueAt: r.dueAt.toISOString(),
          status: r.status,
          whatsapp: r.whatsapp,
          sms: r.sms,
          email: r.email,
          note: r.status === "sent" ? null : r.lastError,
        }))
      : [],
    patientLink: visible && ["tentative", "booked", "confirmed"].includes(a.status) ? appointmentLink(a.id, a.endAt) : null,
    source: a.source,
    payment: visible && a.payments[0] ? { status: a.payments[0].status, amount: a.payments[0].amountPaise / 100, discountPct: a.payments[0].discountPct } : null,
  };
}

/// Pin / unpin a patient flag (★ Priority …) from the appointment card.
export async function setPatientFlag(leadId: string, flagId: string, on: boolean): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  await ensurePermissions();
  if (!can(user.role, "appointments.book") && !can(user.role, "appointments.checkin")) return { ok: false, error: "You don't have permission for that" };
  if (!(await getBoolSetting(PATIENT_FLAGS_ENABLED))) return { ok: false, error: "Patient flags are switched off" };
  try {
    const flag = await prisma.flagDefinition.findUnique({ where: { id: flagId }, select: { label: true } });
    if (!flag) return { ok: false, error: "Unknown flag" };
    if (on) {
      await prisma.leadFlag.upsert({
        where: { leadId_flagId: { leadId, flagId } },
        create: { leadId, flagId, setById: user.id ?? null },
        update: {},
      });
    } else {
      await prisma.leadFlag.deleteMany({ where: { leadId, flagId } });
    }
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: on ? "lead.flag.set" : "lead.flag.clear",
      entityType: "lead",
      entityId: leadId,
      field: "flag",
      newValue: flag.label,
    });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    logger.error(`setPatientFlag failed: ${String(err)}`);
    return { ok: false, error: "Could not update the flag" };
  }
}
