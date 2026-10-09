// Multi-session treatment plans and recall (§2.8). A plan is a set of steps measured
// from an anchor (usually the surgery, Day 0): "post-op wash Day 1 ±0", "PRP Month 1
// ±7 days"… Each step is either BOOKED (a real appointment) or PLANNED with a due
// window. Steps due within 30 days are pre-booked straight away (2.8.b); later ones
// wait in their window and the recall engine chases the patient when it opens (2.8.d).
//
// The plan follows its appointments:
//   - the anchor moves → every later step shifts with it (booked ones are re-booked to
//     the new date where possible) and the plan is flagged for a person to review;
//   - a step's appointment is completed → the step is done (and billing hears of it);
//   - a step's appointment is cancelled / a no-show → the step goes back to planned.
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notifications";
import { getBoolSetting, getNumberSetting } from "@/lib/settings";
import { isServiceWindowOpen, sendLeadTemplate, sendLeadText } from "@/lib/messages";
import { isWhatsAppConfigured } from "@/lib/providers/whatsapp";
import { sendSms } from "@/lib/providers/sms";
import { bookAppointment, findSlots, rescheduleAppointment, type Actor } from "@/lib/scheduling/booking";
import { fillTemplate } from "@/lib/scheduling/messageText";
import { appBaseUrl } from "@/lib/scheduling/links";
import { QUIET_END_HOUR, QUIET_START_HOUR, RECALL_ENABLED } from "@/lib/scheduling/toggles";
import { istDateKey, istInstant, istMinutes, MINUTE_MS } from "@/lib/scheduling/time";

const DAY = 86_400_000;
const PREBOOK_DAYS = 30; // 2.8.b
const SYSTEM: Actor = { id: null, email: "system (treatment plan)" };
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

// ── Dates ────────────────────────────────────────────────────────────────────

/// Anchor + offset. Months are CALENDAR months in IST ("Month 1" after 12 Oct is
/// 12 Nov), keeping the anchor's time of day.
export function addOffset(anchor: Date, value: number, unit: string): Date {
  if (unit === "days") return new Date(anchor.getTime() + value * DAY);
  const shifted = new Date(anchor.getTime() + 330 * MINUTE_MS);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + value);
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return new Date(shifted.getTime() - 330 * MINUTE_MS);
}

/// Target and due window (whole IST days, inclusive).
export function stepWindow(anchor: Date, s: { offsetValue: number; offsetUnit: string; toleranceDays: number }) {
  const targetAt = addOffset(anchor, s.offsetValue, s.offsetUnit);
  const dueFrom = istInstant(istDateKey(new Date(targetAt.getTime() - s.toleranceDays * DAY)), 0);
  const dueTo = istInstant(istDateKey(new Date(targetAt.getTime() + s.toleranceDays * DAY)), 24 * 60);
  return { targetAt, dueFrom, dueTo };
}

// ── Creating a plan ──────────────────────────────────────────────────────────

export async function createPlan(input: {
  leadId: string;
  templateId: string;
  anchorAppointmentId?: string | null;
  anchorAt?: Date | null;
  branchId?: string | null;
  doctorId?: string | null;
  actor?: Actor;
}): Promise<{ ok: true; planId: string; prebooked: number } | { ok: false; error: string }> {
  const t = await prisma.seriesTemplate.findUnique({ where: { id: input.templateId }, include: { steps: { orderBy: { order: "asc" } } } });
  if (!t || !t.active) return { ok: false, error: "Unknown treatment series" };
  if (!t.steps.length) return { ok: false, error: "This series has no steps" };

  let anchorAt = input.anchorAt ?? null;
  let branchId = input.branchId ?? null;
  let doctorId = input.doctorId ?? null;
  if (input.anchorAppointmentId) {
    const a = await prisma.appointment.findUnique({
      where: { id: input.anchorAppointmentId },
      include: { resources: { include: { resource: { select: { id: true, kind: true } } } } },
    });
    if (!a || a.leadId !== input.leadId) return { ok: false, error: "Anchor appointment not found for this patient" };
    anchorAt = a.startAt;
    branchId ??= a.branchId;
    doctorId ??= a.resources.find((r) => r.resource.kind === "doctor")?.resource.id ?? null;
  }
  if (!anchorAt || !branchId) return { ok: false, error: "A plan needs an anchor date and a branch" };

  const plan = await prisma.treatmentPlan.create({
    data: {
      leadId: input.leadId,
      templateId: t.id,
      name: t.name,
      anchorAt,
      anchorAppointmentId: input.anchorAppointmentId ?? null,
      branchId,
      doctorId,
      createdById: input.actor?.id ?? null,
      steps: {
        create: t.steps.map((s) => {
          const w = stepWindow(anchorAt!, s);
          const isAnchor = s.order === t.steps[0].order && s.offsetValue === 0 && !!input.anchorAppointmentId;
          return {
            order: s.order,
            label: s.label,
            typeId: s.typeId,
            offsetValue: s.offsetValue,
            offsetUnit: s.offsetUnit,
            toleranceDays: s.toleranceDays,
            sameDoctor: s.sameDoctor,
            ...w,
            status: isAnchor ? "booked" : "planned",
            appointmentId: isAnchor ? input.anchorAppointmentId : null,
          };
        }),
      },
    },
    include: { steps: true },
  });
  await writeAudit({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    action: "series.plan.create",
    entityType: "lead",
    entityId: input.leadId,
    newValue: `${t.name} — anchor ${anchorAt.toISOString()}`,
    meta: { planId: plan.id },
  });

  // 2.8.b: pre-book what's due within 30 days.
  let prebooked = 0;
  for (const s of plan.steps.filter((x) => x.status === "planned" && x.targetAt.getTime() - Date.now() <= PREBOOK_DAYS * DAY)) {
    if (await prebookStep(s.id, input.actor ?? SYSTEM)) prebooked++;
  }
  return { ok: true, planId: plan.id, prebooked };
}

/// Book a planned step into its window — the target day first, then the days around
/// it, with the plan's surgeon where the step says so (2.8.f). False when nothing fits
/// (the step stays planned and the recall engine takes over).
export async function prebookStep(stepId: string, actor: Actor): Promise<boolean> {
  const s = await prisma.plannedStep.findUnique({ where: { id: stepId }, include: { plan: true } });
  if (!s || s.status !== "planned") return false;
  const days: string[] = [];
  const span = Math.round((s.dueTo.getTime() - s.dueFrom.getTime()) / DAY);
  for (let d = 0; d <= span; d++) {
    for (const sign of d === 0 ? [0] : [1, -1]) {
      const key = istDateKey(new Date(s.targetAt.getTime() + sign * d * DAY));
      const at = istInstant(key, 12 * 60);
      if (at >= s.dueFrom && at <= s.dueTo && at.getTime() > Date.now() && !days.includes(key)) days.push(key);
    }
  }
  const doctor = s.sameDoctor ? s.plan.doctorId : null;
  for (const dateKey of days) {
    const slots = await findSlots({ branchId: s.plan.branchId, typeId: s.typeId, dateKey, resourceIds: doctor ? [doctor] : [], excludeNeedsAck: true });
    const targetMin = istMinutes(s.plan.anchorAt);
    const slot = [...slots].sort((a, b) => Math.abs(istMinutes(a.startAt) - targetMin) - Math.abs(istMinutes(b.startAt) - targetMin))[0];
    if (!slot) continue;
    const r = await bookStepAt(s.id, slot.startAt, actor, s.plan.branchId);
    if (r.ok) return true;
  }
  return false;
}

/// Book a step at a chosen time (staff, the patient's recall link, or prebooking).
export async function bookStepAt(stepId: string, startAt: Date, actor: Actor, branchId?: string | null): Promise<{ ok: true; appointmentId: string } | { ok: false; error: string }> {
  const s = await prisma.plannedStep.findUnique({ where: { id: stepId }, include: { plan: true } });
  if (!s) return { ok: false, error: "Step not found" };
  if (s.status !== "planned") return { ok: false, error: "This step is already booked or closed" };
  const r = await bookAppointment(
    {
      leadId: s.plan.leadId,
      branchId: branchId ?? s.plan.branchId,
      typeId: s.typeId,
      startAt,
      resourceIds: s.sameDoctor && s.plan.doctorId ? [s.plan.doctorId] : [],
      source: "series",
      notes: `${s.plan.name}: ${s.label}`,
    },
    actor,
  );
  if (!r.ok) return { ok: false, error: r.justTaken ? "That time was just taken" : r.error };
  await prisma.plannedStep.update({ where: { id: s.id }, data: { status: "booked", appointmentId: r.appointmentId, callRequired: false } });
  return { ok: true, appointmentId: r.appointmentId };
}

// ── Following the appointments ───────────────────────────────────────────────

/// Booking hook: an appointment of a template's ANCHOR type, for a patient with a
/// converted quote for that package, starts the plan automatically (once).
export async function autoStartFor(appointmentId: string): Promise<void> {
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { id: true, leadId: true, typeId: true, source: true, status: true } });
  if (!a || a.source === "series" || !["booked", "confirmed"].includes(a.status)) return;
  if (await prisma.plannedStep.findUnique({ where: { appointmentId: a.id } })) return;
  const templates = await prisma.seriesTemplate.findMany({ where: { active: true, autoStart: true, anchorTypeId: a.typeId } });
  for (const t of templates) {
    const existing = await prisma.treatmentPlan.count({ where: { leadId: a.leadId, templateId: t.id, status: "active" } });
    if (existing) continue;
    if (t.packageName) {
      const sold = await prisma.quote.count({ where: { leadId: a.leadId, status: { in: ["converted", "in_treatment"] }, treatment: { equals: t.packageName, mode: "insensitive" } } });
      if (!sold) continue;
    }
    const r = await createPlan({ leadId: a.leadId, templateId: t.id, anchorAppointmentId: a.id });
    if (r.ok) logger.info(`Treatment plan ${r.planId} started automatically (${t.name}), ${r.prebooked} step(s) pre-booked`);
  }
}

/// Reschedule hook: steps and anchors follow the new appointment row; a moved ANCHOR
/// shifts the whole plan.
export async function onAppointmentMoved(oldId: string, newId: string, actor: Actor): Promise<void> {
  await prisma.plannedStep.updateMany({ where: { appointmentId: oldId }, data: { appointmentId: newId } });
  const plans = await prisma.treatmentPlan.findMany({ where: { anchorAppointmentId: oldId, status: "active" } });
  if (!plans.length) return;
  const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: newId }, select: { startAt: true } });
  for (const p of plans) {
    await prisma.treatmentPlan.update({ where: { id: p.id }, data: { anchorAppointmentId: newId } });
    await shiftPlan(p.id, moved.startAt, actor);
  }
}

/// The anchor moved (surgery rescheduled): recalculate every later step, re-book the
/// booked ones into their new windows where possible, and ask a person to review
/// (2.8 "dependent steps shift automatically and a staff member is asked to confirm").
export async function shiftPlan(planId: string, newAnchor: Date, actor: Actor): Promise<void> {
  const plan = await prisma.treatmentPlan.findUniqueOrThrow({ where: { id: planId }, include: { steps: { orderBy: { order: "asc" } }, lead: { select: { name: true } } } });
  const oldAnchor = plan.anchorAt;
  await prisma.treatmentPlan.update({ where: { id: planId }, data: { anchorAt: newAnchor } });
  const unresolved: string[] = [];
  for (const s of plan.steps) {
    if (s.appointmentId === plan.anchorAppointmentId || ["completed", "waived"].includes(s.status)) continue;
    const w = stepWindow(newAnchor, s);
    await prisma.plannedStep.update({ where: { id: s.id }, data: { ...w, recallStage: 0, callRequired: false } });
    if (s.status === "booked" && s.appointmentId) {
      const appt = await prisma.appointment.findUnique({ where: { id: s.appointmentId }, select: { startAt: true } });
      if (appt && appt.startAt >= w.dueFrom && appt.startAt <= w.dueTo) continue; // still fits
      // Move it into the new window, same doctor, nearest the new target.
      let movedOk = false;
      for (let d = 0; d <= s.toleranceDays && !movedOk; d++) {
        for (const sign of d === 0 ? [0] : [1, -1]) {
          const key = istDateKey(new Date(w.targetAt.getTime() + sign * d * DAY));
          if (istInstant(key, 12 * 60).getTime() < Date.now()) continue;
          const slots = await findSlots({ branchId: plan.branchId, typeId: s.typeId, dateKey: key, resourceIds: s.sameDoctor && plan.doctorId ? [plan.doctorId] : [], excludeNeedsAck: true, ignoreAppointmentIds: [s.appointmentId] });
          if (!slots.length) continue;
          const r = await rescheduleAppointment(s.appointmentId, { startAt: slots[0].startAt, reason: "Treatment plan anchor moved" }, actor);
          if (r.ok) {
            movedOk = true;
            break;
          }
        }
      }
      if (!movedOk) unresolved.push(s.label);
    }
  }
  const note = `Anchor moved from ${dayFmt.format(oldAnchor)} to ${dayFmt.format(newAnchor)} — confirm the shifted follow-ups${unresolved.length ? `; couldn't re-book: ${unresolved.join(", ")}` : ""}.`;
  await prisma.treatmentPlan.update({ where: { id: planId }, data: { needsReview: true, reviewNote: note } });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "series.plan.shift", entityType: "lead", entityId: plan.leadId, newValue: note, meta: { planId } });
  const branch = await prisma.branch.findUnique({ where: { id: plan.branchId }, select: { managerId: true } });
  if (branch?.managerId) {
    await notifyUser({ userId: branch.managerId, kind: "appointment_rebooking", title: `Confirm shifted follow-ups for ${plan.lead.name}`, body: note, href: `/appointments/plans/${planId}`, dedupeKey: `plan-shift:${planId}:${newAnchor.getTime()}` });
  }
}

/// Status hook: completed → the step is done (billing hears); cancelled / no-show →
/// back to planned so the recall engine picks it up again.
export async function onAppointmentStatus(appointmentId: string, to: string, actor: Actor): Promise<void> {
  const s = await prisma.plannedStep.findUnique({ where: { appointmentId }, include: { plan: { select: { id: true, leadId: true, name: true } } } });
  if (!s) return;
  if (to === "completed") {
    await prisma.plannedStep.update({ where: { id: s.id }, data: { status: "completed", completedAt: new Date() } });
    const steps = await prisma.plannedStep.findMany({ where: { planId: s.planId }, select: { status: true } });
    const done = steps.filter((x) => ["completed", "waived"].includes(x.status)).length;
    // The event Billing (3.4) will consume to recognise the delivered part of the package.
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "series.step.completed",
      entityType: "lead",
      entityId: s.plan.leadId,
      newValue: `${s.plan.name}: ${s.label} (${done} of ${steps.length})`,
      meta: { planId: s.planId, stepId: s.id, appointmentId },
    });
    if (done === steps.length) await prisma.treatmentPlan.update({ where: { id: s.planId }, data: { status: "completed" } });
  } else if (to === "cancelled" || to === "no_show") {
    await prisma.plannedStep.update({ where: { id: s.id }, data: { status: "planned", appointmentId: null, recallStage: 0, callRequired: false } });
  }
}

// ── Editing one patient's plan (2.8 "custom plan", 2.8.c) ────────────────────

export async function extendStep(stepId: string, days: number, reason: string, actor: Actor) {
  if (!reason.trim()) return { ok: false, error: "Give a reason" };
  if (!(days > 0 && days <= 365)) return { ok: false, error: "Extend by 1–365 days" };
  const s = await prisma.plannedStep.findUnique({ where: { id: stepId }, select: { dueTo: true, plan: { select: { leadId: true } } } });
  if (!s) return { ok: false, error: "Step not found" };
  await prisma.plannedStep.update({ where: { id: stepId }, data: { dueTo: new Date(s.dueTo.getTime() + days * DAY), callRequired: false, note: `Extended ${days} days: ${reason.trim()}` } });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "series.step.extend", entityType: "lead", entityId: s.plan.leadId, newValue: `+${days} days`, reason: reason.trim(), meta: { stepId } });
  return { ok: true };
}

export async function waiveStep(stepId: string, reason: string, actor: Actor) {
  if (!reason.trim()) return { ok: false, error: "Give a reason" };
  const s = await prisma.plannedStep.findUnique({ where: { id: stepId }, select: { status: true, plan: { select: { leadId: true } } } });
  if (!s) return { ok: false, error: "Step not found" };
  if (s.status === "booked") return { ok: false, error: "Cancel the booked appointment first" };
  await prisma.plannedStep.update({ where: { id: stepId }, data: { status: "waived", callRequired: false, note: `Waived: ${reason.trim()}` } });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "series.step.waive", entityType: "lead", entityId: s.plan.leadId, reason: reason.trim(), meta: { stepId } });
  return { ok: true };
}

/// Move one step's target for this patient only (the template is untouched).
export async function retargetStep(stepId: string, dateKey: string, actor: Actor) {
  const s = await prisma.plannedStep.findUnique({ where: { id: stepId }, select: { status: true, toleranceDays: true, plan: { select: { leadId: true } } } });
  if (!s) return { ok: false, error: "Step not found" };
  if (s.status !== "planned") return { ok: false, error: "Only a step that isn't booked yet can be re-dated" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { ok: false, error: "Pick a date" };
  const targetAt = istInstant(dateKey, 11 * 60);
  await prisma.plannedStep.update({
    where: { id: stepId },
    data: {
      targetAt,
      dueFrom: istInstant(istDateKey(new Date(targetAt.getTime() - s.toleranceDays * DAY)), 0),
      dueTo: istInstant(istDateKey(new Date(targetAt.getTime() + s.toleranceDays * DAY)), 24 * 60),
      recallStage: 0,
      callRequired: false,
    },
  });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "series.step.retarget", entityType: "lead", entityId: s.plan.leadId, newValue: dateKey, meta: { stepId } });
  return { ok: true };
}

// ── Recall (2.8.d) ───────────────────────────────────────────────────────────

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

/// The patient's link to book a due step — signed, valid 30 days past the window.
export function recallToken(stepId: string, dueTo: Date): string {
  const exp = Math.floor((dueTo.getTime() + 30 * DAY) / 1000).toString(36);
  const payload = `${stepId}.${exp}`;
  return `${payload}.${createHmac("sha256", secret()).update(`recall:${payload}`).digest("base64url").slice(0, 32)}`;
}

export function readRecallToken(token: string): string | null {
  const [id, exp, sig] = token.split(".");
  if (!id || !exp || !sig) return null;
  const expected = createHmac("sha256", secret()).update(`recall:${id}.${exp}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b) || parseInt(exp, 36) * 1000 < Date.now()) return null;
  return id;
}

async function sendRecall(stepId: string, withSms: boolean): Promise<string> {
  const s = await prisma.plannedStep.findUniqueOrThrow({ where: { id: stepId }, include: { plan: { include: { lead: { select: { id: true, name: true, phone: true } } } } } });
  const tpl = await prisma.appointmentMessageTemplate.findUnique({ where: { key: "recall_due" } });
  if (!tpl) return "no recall message set";
  const vars: Record<string, string> = {
    patient_name: s.plan.lead.name.trim().split(/\s+/)[0] ?? "",
    step: s.label,
    due_from: dayFmt.format(s.dueFrom),
    due_to: dayFmt.format(new Date(s.dueTo.getTime() - 1)),
    recall_link: `${appBaseUrl()}/r/${recallToken(s.id, s.dueTo)}`,
    clinic: "Cara Clinic",
  };
  const text = fillTemplate(tpl.body, vars);
  const out: string[] = [];
  let waOk = false;
  if (isWhatsAppConfigured()) {
    const r = (await isServiceWindowOpen(s.plan.lead.id))
      ? await sendLeadText(s.plan.lead.id, text, { automated: true, clinical: true })
      : tpl.whatsappTemplateName
        ? await sendLeadTemplate(s.plan.lead.id, tpl.whatsappTemplateName, tpl.whatsappLanguage, [{ type: "body", parameters: tpl.whatsappParams.map((p) => ({ type: "text", text: vars[p] || "-" })) }], { automated: true, clinical: true })
        : { ok: false as const, error: "no approved WhatsApp template" };
    waOk = r.ok;
    out.push(r.ok ? "whatsapp sent" : `whatsapp: ${r.error}`);
  } else out.push("whatsapp not configured");
  if (withSms || !waOk) {
    const r = await sendSms(s.plan.lead.phone, text, tpl.smsDltTemplateId);
    out.push(r.ok ? "sms sent" : `sms: ${r.error}`);
  }
  return out.join(" · ");
}

/// The recall tick (worker): for every planned step whose window has opened —
///   day 0: WhatsApp · day 3: WhatsApp + SMS · day 7: a call task for the branch.
/// Off (nothing sent) until the clinic switches recall on; quiet hours respected.
export async function processRecalls(now = new Date()): Promise<{ sent: number; callTasks: number }> {
  const tally = { sent: 0, callTasks: 0 };
  if (!(await getBoolSetting(RECALL_ENABLED))) return tally;
  const [qs, qe] = await Promise.all([getNumberSetting(QUIET_START_HOUR), getNumberSetting(QUIET_END_HOUR)]);
  const m = istMinutes(now);
  const quiet = qs > qe ? m >= qs * 60 || m < qe * 60 : m >= qs * 60 && m < qe * 60;
  const due = await prisma.plannedStep.findMany({
    where: { status: "planned", dueFrom: { lte: now }, recallStage: { lt: 3 }, plan: { status: "active" } },
    include: { plan: { select: { id: true, branchId: true, lead: { select: { name: true } } } } },
    take: 100,
  });
  for (const s of due) {
    const age = (now.getTime() - s.dueFrom.getTime()) / DAY;
    try {
      if (s.recallStage === 0 && !quiet) {
        const res = await sendRecall(s.id, false);
        await prisma.plannedStep.update({ where: { id: s.id }, data: { recallStage: 1, lastRecallAt: now, note: `Recall: ${res}` } });
        tally.sent++;
      } else if (s.recallStage === 1 && age >= 3 && !quiet) {
        const res = await sendRecall(s.id, true);
        await prisma.plannedStep.update({ where: { id: s.id }, data: { recallStage: 2, lastRecallAt: now, note: `Recall (2nd): ${res}` } });
        tally.sent++;
      } else if (s.recallStage === 2 && age >= 7) {
        await prisma.plannedStep.update({ where: { id: s.id }, data: { recallStage: 3, callRequired: true } });
        const branch = await prisma.branch.findUnique({ where: { id: s.plan.branchId }, select: { managerId: true } });
        if (branch?.managerId) {
          await notifyUser({ userId: branch.managerId, kind: "appointment_rebooking", title: `Call: ${s.plan.lead.name} — ${s.label} not booked`, body: "Recall messages didn't get a booking", href: "/appointments/recall", dedupeKey: `recall-call:${s.id}` });
        }
        tally.callTasks++;
      }
    } catch (err) {
      logger.error(`Recall for step ${s.id} failed: ${String(err)}`);
    }
  }
  return tally;
}

/// The branch recall list (2.8): overdue, due this week, due in the next 30 days.
export async function recallList(branchId: string | null, now = new Date()) {
  const rows = await prisma.plannedStep.findMany({
    where: { status: "planned", dueFrom: { lte: new Date(now.getTime() + 30 * DAY) }, plan: { status: "active", ...(branchId ? { branchId } : {}) } },
    orderBy: { dueFrom: "asc" },
    include: { plan: { select: { id: true, name: true, branchId: true, lead: { select: { id: true, name: true, phone: true } } } } },
  });
  const overdue = rows.filter((r) => r.dueTo < now);
  const thisWeek = rows.filter((r) => r.dueTo >= now && r.dueFrom <= new Date(now.getTime() + 7 * DAY));
  const later = rows.filter((r) => r.dueFrom > new Date(now.getTime() + 7 * DAY));
  return { overdue, thisWeek, later };
}
