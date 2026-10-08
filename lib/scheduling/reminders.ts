// Appointment reminders (§3.2 2.4). Generated from the appointment type's rules when
// an appointment is booked, cancelled when it moves or ends (the moved appointment gets
// fresh ones), and sent by the worker tick — a queue, not a loop in a request.
//
// CHANNELS (2.4): WhatsApp first. Inside the 24-hour window the text goes as written;
// outside it Meta only delivers a PRE-APPROVED template, so the message's
// `whatsappTemplateName` + params are used — and without one, WhatsApp is skipped and
// said so. SMS when WhatsApp didn't get through (if the rule allows fallback) or when
// the rule lists SMS; a WhatsApp message that later reports "failed" also triggers the
// SMS fallback. Email in parallel when listed (surgery instructions).
//
// RULES THAT DON'T BEND: reminders are transactional — they follow CLINICAL consent,
// not the marketing opt-out (`clinical: true`). Quiet hours (default 21:00–08:00 IST)
// hold a reminder until morning, except a quiet-exempt rule (the morning-of-surgery
// message). A reminder whose moment has passed by the time it could go out is skipped,
// never sent late. While the module's reminders switch is off, due reminders are marked
// skipped — switching on never sends a backlog.
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { getBoolSetting, getNumberSetting } from "@/lib/settings";
import { isServiceWindowOpen, leadIdsSharingPhone, sendLeadTemplate, sendLeadText } from "@/lib/messages";
import { isWhatsAppConfigured } from "@/lib/providers/whatsapp";
import { sendSms } from "@/lib/providers/sms";
import { sendEmail } from "@/lib/providers/email";
import { appointmentLink } from "@/lib/scheduling/links";
import { istDateKey, istInstant, istMinutes, MINUTE_MS } from "@/lib/scheduling/time";
import { QUIET_END_HOUR, QUIET_START_HOUR, REMINDERS_ENABLED, SELF_SERVICE_LINKS } from "@/lib/scheduling/toggles";
import { fillTemplate } from "@/lib/scheduling/messageText";

export { fillTemplate, REMINDER_PRESETS, TEMPLATE_VARIABLES } from "@/lib/scheduling/messageText";

const LIVE = ["booked", "confirmed"];

// ── Variables & templates ────────────────────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });

export async function appointmentVariables(appointmentId: string): Promise<Record<string, string> | null> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      lead: { select: { name: true } },
      type: { select: { name: true, prepInstructions: true } },
      branch: { select: { name: true, addressLine1: true, addressLine2: true, city: true, phone: true } },
      resources: { include: { resource: { select: { name: true, kind: true } } } },
    },
  });
  if (!a) return null;
  const address = [a.branch.addressLine1, a.branch.addressLine2, a.branch.city].filter(Boolean).join(", ");
  const selfService = await getBoolSetting(SELF_SERVICE_LINKS);
  return {
    patient_name: a.lead.name.trim().split(/\s+/)[0] ?? "",
    patient_full_name: a.lead.name,
    date: dayFmt.format(a.startAt),
    time: timeFmt.format(a.startAt).toUpperCase(),
    service: a.type.name,
    doctor: a.resources.find((r) => r.resource.kind === "doctor")?.resource.name ?? "our team",
    branch: a.branch.name,
    branch_address: address,
    branch_phone: a.branch.phone ?? "the clinic",
    map_link: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || a.branch.name)}`,
    prep: a.type.prepInstructions ?? "",
    link: selfService ? appointmentLink(a.id, a.endAt) : "",
    clinic: "Cara Clinic",
  };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

async function quietWindow(): Promise<{ start: number; end: number }> {
  const [start, end] = await Promise.all([getNumberSetting(QUIET_START_HOUR), getNumberSetting(QUIET_END_HOUR)]);
  return { start: start * 60, end: end * 60 };
}

function inQuiet(at: Date, q: { start: number; end: number }): boolean {
  if (q.start === q.end) return false;
  const m = istMinutes(at);
  return q.start > q.end ? m >= q.start || m < q.end : m >= q.start && m < q.end;
}

/// The next moment quiet hours end, at or after `at`.
function afterQuiet(at: Date, q: { start: number; end: number }): Date {
  const key = istDateKey(at);
  const sameDayEnd = istInstant(key, q.end);
  return sameDayEnd > at ? sameDayEnd : new Date(sameDayEnd.getTime() + 86_400_000);
}

/// When a rule's message should go for this appointment, or null when it shouldn't
/// (its moment already passed, or would land after the appointment started).
export function dueTime(
  rule: { kind: string; minutesBefore: number | null; atMin: number | null; quietExempt: boolean },
  startAt: Date,
  now: Date,
  quiet: { start: number; end: number },
): Date | null {
  let due: Date;
  if (rule.kind === "on_booking") due = now;
  else if (rule.kind === "morning_of") due = istInstant(istDateKey(startAt), rule.atMin ?? 7 * 60);
  else due = new Date(startAt.getTime() - (rule.minutesBefore ?? 0) * MINUTE_MS);

  if (rule.kind !== "on_booking" && due < now) return null; // booked too late for this one
  if (!rule.quietExempt && inQuiet(due, quiet)) due = afterQuiet(due, quiet);
  // A reminder must arrive with time to act on it.
  if (due.getTime() > startAt.getTime() - 15 * MINUTE_MS) return null;
  return due;
}

/// Create this appointment's reminders from its type's rules. `skipOnBooking` for a
/// reschedule (the patient was just told by whoever moved it).
export async function scheduleReminders(appointmentId: string, opts: { skipOnBooking?: boolean } = {}): Promise<number> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { status: true, startAt: true, type: { select: { reminderRules: { orderBy: { sortOrder: "asc" } } } } },
  });
  if (!a || !LIVE.includes(a.status)) return 0;
  const existing = await prisma.appointmentReminder.count({ where: { appointmentId, status: { not: "cancelled" } } });
  if (existing) return 0; // idempotent
  const now = new Date();
  const quiet = await quietWindow();
  const rows = [];
  for (const r of a.type.reminderRules) {
    if (opts.skipOnBooking && r.kind === "on_booking") continue;
    const due = dueTime(r, a.startAt, now, quiet);
    if (!due) continue;
    rows.push({
      appointmentId,
      ruleId: r.id,
      templateId: r.templateId,
      dueAt: due,
      channels: r.channels,
      smsFallback: r.smsFallback,
      quietExempt: r.quietExempt,
    });
  }
  if (rows.length) await prisma.appointmentReminder.createMany({ data: rows });
  return rows.length;
}

export async function cancelReminders(appointmentId: string, reason: string): Promise<number> {
  const r = await prisma.appointmentReminder.updateMany({
    where: { appointmentId, status: "pending" },
    data: { status: "cancelled", lastError: reason },
  });
  return r.count;
}

// ── Sending ──────────────────────────────────────────────────────────────────

/// Meta refuses template parameters containing newlines or tabs.
const waParam = (v: string) => (v || "-").replace(/[\n\t]+/g, " · ").replace(/ {4,}/g, "   ").slice(0, 1000);

type Outcome = { whatsapp?: string; waId?: string; sms?: string; smsRef?: string; email?: string };

async function deliver(reminderId: string): Promise<{ status: string; outcome: Outcome; error?: string }> {
  const rem = await prisma.appointmentReminder.findUniqueOrThrow({
    where: { id: reminderId },
    include: { template: true, appointment: { select: { id: true, status: true, startAt: true, leadId: true, lead: { select: { phone: true, email: true } } } } },
  });
  const a = rem.appointment;
  const vars = await appointmentVariables(a.id);
  if (!vars) return { status: "skipped", outcome: {}, error: "Appointment gone" };
  const text = fillTemplate(rem.template.body, vars);
  const outcome: Outcome = {};
  let anySent = false;
  let anyFailed = false;

  // 1. WhatsApp
  if (rem.channels.includes("whatsapp")) {
    if (!isWhatsAppConfigured()) outcome.whatsapp = "skipped: WhatsApp not configured";
    else if (await isServiceWindowOpen(a.leadId)) {
      const r = await sendLeadText(a.leadId, text, { automated: true, clinical: true });
      if (r.ok) {
        outcome.whatsapp = "sent";
        outcome.waId = r.message.waId ?? undefined;
      } else outcome.whatsapp = `failed: ${r.error}`;
    } else if (rem.template.whatsappTemplateName) {
      const params = (rem.template.whatsappParams.length ? rem.template.whatsappParams : []).map((p) => ({ type: "text", text: waParam(vars[p] ?? "") }));
      const r = await sendLeadTemplate(
        a.leadId,
        rem.template.whatsappTemplateName,
        rem.template.whatsappLanguage,
        params.length ? [{ type: "body", parameters: params }] : undefined,
        { automated: true, clinical: true },
      );
      if (r.ok) {
        outcome.whatsapp = "sent";
        outcome.waId = r.message.waId ?? undefined;
      } else outcome.whatsapp = `failed: ${r.error}`;
    } else outcome.whatsapp = "skipped: outside the 24h window and no approved WhatsApp template set";
    if (outcome.whatsapp === "sent") anySent = true;
    else if (outcome.whatsapp.startsWith("failed")) anyFailed = true;
  }

  // 2. SMS — listed, or as the fallback when WhatsApp didn't go.
  const waOk = outcome.whatsapp === "sent";
  if (rem.channels.includes("sms") || (rem.smsFallback && rem.channels.includes("whatsapp") && !waOk)) {
    const r = await sendSms(a.lead.phone, text, rem.template.smsDltTemplateId);
    if (r.ok) {
      outcome.sms = "sent";
      outcome.smsRef = r.ref;
      anySent = true;
    } else {
      outcome.sms = `${r.error.includes("not configured") || r.error.includes("No DLT") ? "skipped" : "failed"}: ${r.error}`;
      if (outcome.sms.startsWith("failed")) anyFailed = true;
    }
  }

  // 3. Email, in parallel when listed.
  if (rem.channels.includes("email")) {
    if (!a.lead.email) outcome.email = "skipped: no email on file";
    else {
      const r = await sendEmail(a.lead.email, fillTemplate(rem.template.emailSubject ?? rem.template.name, vars), text);
      outcome.email = r.ok ? "sent" : `${r.error.includes("not configured") ? "skipped" : "failed"}: ${r.error}`;
      if (r.ok) anySent = true;
      else if (outcome.email.startsWith("failed")) anyFailed = true;
    }
  }

  return {
    status: anySent ? "sent" : anyFailed ? "failed" : "skipped",
    outcome,
    error: anySent ? undefined : [outcome.whatsapp, outcome.sms, outcome.email].filter(Boolean).join(" | "),
  };
}

/// The worker tick: send every reminder that has come due.
export async function processDueReminders(now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
  const due = await prisma.appointmentReminder.findMany({
    where: { status: "pending", dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
    take: 50,
    include: { appointment: { select: { status: true, startAt: true } } },
  });
  const tally = { sent: 0, skipped: 0, failed: 0 };
  if (!due.length) return tally;
  const enabled = await getBoolSetting(REMINDERS_ENABLED);
  const quiet = await quietWindow();

  for (const rem of due) {
    // Claim it, so two worker ticks can't both send it.
    const claimed = await prisma.appointmentReminder.updateMany({ where: { id: rem.id, status: "pending" }, data: { status: "sending", attempts: { increment: 1 } } });
    if (claimed.count !== 1) continue;
    const finish = (status: string, data: Record<string, unknown> = {}) =>
      prisma.appointmentReminder.update({ where: { id: rem.id }, data: { status, ...data } });

    if (!enabled) {
      await finish("skipped", { lastError: "Reminders are switched off" });
      tally.skipped++;
      continue;
    }
    if (!LIVE.includes(rem.appointment.status)) {
      await finish("cancelled", { lastError: `Appointment is ${rem.appointment.status}` });
      continue;
    }
    if (rem.appointment.startAt.getTime() - now.getTime() < 10 * MINUTE_MS) {
      await finish("skipped", { lastError: "Too close to the appointment" });
      tally.skipped++;
      continue;
    }
    if (!rem.quietExempt && inQuiet(now, quiet)) {
      // Held by quiet hours (e.g. created before the hours were changed).
      const next = afterQuiet(now, quiet);
      if (next.getTime() < rem.appointment.startAt.getTime() - 15 * MINUTE_MS) await finish("pending", { dueAt: next });
      else {
        await finish("skipped", { lastError: "Quiet hours until the appointment" });
        tally.skipped++;
      }
      continue;
    }
    try {
      const r = await deliver(rem.id);
      await finish(r.status, { ...r.outcome, sentAt: r.status === "sent" ? new Date() : null, lastError: r.error ?? null });
      tally[r.status as "sent" | "skipped" | "failed"]++;
    } catch (err) {
      logger.error(`Reminder ${rem.id} failed: ${String(err)}`);
      await finish("failed", { lastError: String(err).slice(0, 300) });
      tally.failed++;
    }
  }
  return tally;
}

/// WhatsApp delivery receipts (webhook): record delivered / read on the reminder, and
/// when Meta reports the message FAILED (number not on WhatsApp…), send the SMS
/// fallback if the rule allows and SMS hasn't gone yet (2.4 "if undelivered, fall back
/// to SMS automatically").
export async function onWhatsAppStatus(waId: string, status: string): Promise<void> {
  const rem = await prisma.appointmentReminder.findFirst({
    where: { waId },
    include: { template: true, appointment: { select: { id: true, status: true, lead: { select: { phone: true } } } } },
  });
  if (!rem) return;
  await prisma.appointmentReminder.update({ where: { id: rem.id }, data: { whatsapp: status === "failed" ? "failed: undelivered" : status } });
  if (status !== "failed" || !rem.smsFallback || rem.sms === "sent" || !LIVE.includes(rem.appointment.status)) return;
  const vars = await appointmentVariables(rem.appointment.id);
  if (!vars) return;
  const r = await sendSms(rem.appointment.lead.phone, fillTemplate(rem.template.body, vars), rem.template.smsDltTemplateId);
  await prisma.appointmentReminder.update({
    where: { id: rem.id },
    data: r.ok ? { sms: "sent (fallback)", smsRef: r.ref } : { sms: `failed: ${r.error}` },
  });
}

// ── Replies: "1" confirm, "2" reschedule (2.4 example) ───────────────────────

/// Handle a patient's reply to a reminder. Returns true when the message was about an
/// appointment (so the chatbot doesn't also answer it).
export async function handleAppointmentReply(leadId: string, text: string, interactiveId?: string | null): Promise<boolean> {
  const norm = text.trim().toLowerCase();
  const intent =
    norm === "1" || norm === "confirm" || interactiveId === "appt_confirm"
      ? "confirm"
      : norm === "2" || norm === "reschedule" || interactiveId === "appt_reschedule"
        ? "reschedule"
        : null;
  if (!intent) return false;

  const ids = await leadIdsSharingPhone(leadId);
  const since = new Date(Date.now() - 10 * 86_400_000);
  const rem = await prisma.appointmentReminder.findFirst({
    where: {
      status: "sent",
      sentAt: { gte: since },
      appointment: { leadId: { in: ids }, status: { in: LIVE }, startAt: { gt: new Date() } },
    },
    orderBy: { appointment: { startAt: "asc" } },
    include: { appointment: { select: { id: true, status: true, startAt: true, endAt: true, type: { select: { selfServiceCutoffHours: true } } } } },
  });
  if (!rem) return false;
  const a = rem.appointment;
  const { changeAppointmentStatus } = await import("@/lib/scheduling/booking");
  const when = `${dayFmt.format(a.startAt)} at ${timeFmt.format(a.startAt).toUpperCase()}`;

  if (intent === "confirm") {
    if (a.status === "booked") await changeAppointmentStatus(a.id, "confirmed", {}, { email: "patient (WhatsApp reply)" });
    await sendLeadText(leadId, `Thank you — your appointment on ${when} is confirmed. See you then!`, { automated: true, clinical: true });
    return true;
  }

  const hoursLeft = (a.startAt.getTime() - Date.now()) / 3_600_000;
  const selfService = await getBoolSetting(SELF_SERVICE_LINKS);
  if (selfService && hoursLeft >= a.type.selfServiceCutoffHours) {
    await sendLeadText(leadId, `You can choose a new time for your ${when} appointment here: ${appointmentLink(a.id, a.endAt)}`, { automated: true, clinical: true });
  } else {
    const { openPatientRequest } = await import("@/lib/scheduling/conflicts");
    await openPatientRequest(a.id, `Patient asked to reschedule by WhatsApp (inside the ${a.type.selfServiceCutoffHours} h window) — call required`);
    await sendLeadText(leadId, "Thanks — our patient-care team will call you shortly to arrange a new time.", { automated: true, clinical: true });
  }
  return true;
}
