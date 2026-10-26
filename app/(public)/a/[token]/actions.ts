"use server";

// The patient's own actions from their appointment link (§2.4). No login: every call
// re-verifies the signed token, re-reads the appointment, and re-applies the type's
// self-service cut-off — the page's buttons are a convenience, not the rule. Rate
// limited per appointment and per IP, because this is the open internet.
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { getBoolSetting } from "@/lib/settings";
import { verifyAppointmentToken, appointmentToken } from "@/lib/scheduling/links";
import { changeAppointmentStatus, findSlots, rescheduleAppointment } from "@/lib/scheduling/booking";
import { openPatientRequest } from "@/lib/scheduling/conflicts";
import { SELF_SERVICE_LINKS } from "@/lib/scheduling/toggles";
import { istDateKey } from "@/lib/scheduling/time";

type Result = { ok: boolean; error?: string; info?: string; token?: string };
const PATIENT = { id: null, email: "patient (self-service link)" };
const LIVE = ["booked", "confirmed"];

async function load(token: string) {
  const v = verifyAppointmentToken(token);
  if (!v) return { error: "This link has expired. Please call the clinic." as const };
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const [a, b] = await Promise.all([rateLimit(`appt-link:${v.appointmentId}`, 30, 3600), rateLimit(`appt-link-ip:${ip}`, 60, 3600)]);
  if (!a.ok || !b.ok) return { error: "Too many attempts — please try again later or call the clinic." as const };
  const appt = await prisma.appointment.findUnique({
    where: { id: v.appointmentId },
    include: { type: { select: { selfServiceCutoffHours: true } }, resources: { include: { resource: { select: { id: true, kind: true } } } } },
  });
  if (!appt) return { error: "Appointment not found." as const };
  return { appt };
}

async function selfServiceAllowed(startAt: Date, cutoffHours: number): Promise<boolean> {
  if (!(await getBoolSetting(SELF_SERVICE_LINKS))) return false;
  return (startAt.getTime() - Date.now()) / 3_600_000 >= cutoffHours;
}

export async function patientConfirm(token: string): Promise<Result> {
  const l = await load(token);
  if ("error" in l) return { ok: false, error: l.error };
  if (l.appt.status === "confirmed") return { ok: true, info: "Already confirmed — see you then!" };
  if (l.appt.status !== "booked") return { ok: false, error: "This appointment can't be confirmed any more." };
  const r = await changeAppointmentStatus(l.appt.id, "confirmed", {}, PATIENT);
  return r.ok ? { ok: true, info: "Confirmed — thank you. See you then!" } : { ok: false, error: r.error };
}

export async function patientSlots(token: string, dateKey: string): Promise<{ startAt: string; endAt: string }[]> {
  const l = await load(token);
  if ("error" in l || !LIVE.includes(l.appt.status)) return [];
  if (!(await selfServiceAllowed(l.appt.startAt, l.appt.type.selfServiceCutoffHours))) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || dateKey < istDateKey(new Date())) return [];
  const doctor = l.appt.resources.find((r) => r.resource.kind === "doctor")?.resource.id;
  const slots = await findSlots({ branchId: l.appt.branchId, typeId: l.appt.typeId, dateKey, resourceIds: doctor ? [doctor] : [], excludeNeedsAck: true });
  const soonest = Date.now() + 2 * 3_600_000; // not something starting in the next 2 h
  return slots
    .filter((s) => s.startAt.getTime() >= soonest)
    .map((s) => ({ startAt: s.startAt.toISOString(), endAt: s.endAt.toISOString() }));
}

export async function patientReschedule(token: string, startAt: string): Promise<Result> {
  const l = await load(token);
  if ("error" in l) return { ok: false, error: l.error };
  if (!LIVE.includes(l.appt.status)) return { ok: false, error: "This appointment can't be changed any more." };
  if (!(await selfServiceAllowed(l.appt.startAt, l.appt.type.selfServiceCutoffHours))) {
    return { ok: false, error: "It's too close to your appointment to change it online — please call the clinic." };
  }
  const when = new Date(startAt);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 2 * 3_600_000) return { ok: false, error: "Pick another time." };
  const doctor = l.appt.resources.find((r) => r.resource.kind === "doctor")?.resource.id;
  const r = await rescheduleAppointment(l.appt.id, { startAt: when, resourceIds: doctor ? [doctor] : undefined, reason: "Patient rescheduled via link" }, PATIENT);
  if (!r.ok) return { ok: false, error: r.justTaken ? "That time was just taken — please pick another." : "That time isn't available — please pick another." };
  const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId }, select: { endAt: true } });
  return { ok: true, info: "Done — your appointment has been moved.", token: appointmentToken(r.appointmentId, moved.endAt) };
}

export async function patientCancel(token: string, reason: string): Promise<Result> {
  const l = await load(token);
  if ("error" in l) return { ok: false, error: l.error };
  if (!LIVE.includes(l.appt.status)) return { ok: false, error: "This appointment can't be changed any more." };
  if (!(await selfServiceAllowed(l.appt.startAt, l.appt.type.selfServiceCutoffHours))) {
    return { ok: false, error: "It's too close to your appointment to cancel online — please call the clinic." };
  }
  const r = await changeAppointmentStatus(l.appt.id, "cancelled", { reason: reason.trim() || "Cancelled by patient via link", cancelledBy: "patient" }, PATIENT);
  return r.ok ? { ok: true, info: "Your appointment has been cancelled." } : { ok: false, error: r.error };
}

/// Inside the cut-off: the patient can still ask — it lands on the patient-care
/// worklist as "Patient requested change — call required".
export async function patientRequestChange(token: string, note: string): Promise<Result> {
  const l = await load(token);
  if ("error" in l) return { ok: false, error: l.error };
  if (!LIVE.includes(l.appt.status)) return { ok: false, error: "This appointment can't be changed any more." };
  await openPatientRequest(l.appt.id, `Patient requested a change via link${note.trim() ? `: "${note.trim().slice(0, 200)}"` : ""} — call required`);
  return { ok: true, info: "Thanks — our patient-care team will call you shortly." };
}
