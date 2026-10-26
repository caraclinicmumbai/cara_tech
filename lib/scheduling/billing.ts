// Appointments → Billing (spec §3, row 3.4), with decision 3.c.
//
//   • PAYMENTS are confirmed by the patient's browser (checkout callback) OR by Razorpay's
//     server webhook, whichever lands first — `markPaid` is the one path both use. Before
//     the webhook, a patient who paid and closed the tab had paid for a hold that then
//     lapsed, and nothing in the CRM knew.
//   • A paid deposit on an appointment that DIDN'T HAPPEN (no-show, cancelled, a hold that
//     lapsed after payment) becomes PATIENT CREDIT — never forfeited by the system. The
//     reason (no-show / late cancel / …) is recorded for the desk; what to do with it is a
//     person's decision: apply it to the next booking, or a manager refunds it.
//   • A COMPLETED appointment writes a RevenueEvent — "session 3 of 6 of this quote, worth
//     ₹X" — for Billing to consume. Replaces the bare audit event the series used to leave.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { refundRazorpayPayment } from "@/lib/providers/razorpay";
import type { Actor } from "@/lib/scheduling/booking";

const HOUR_MS = 3_600_000;

/// Record a payment as paid, once. Returns false when it already was (a callback and the
/// webhook both arriving is normal).
export async function markPaid(
  orderId: string,
  paymentId: string,
  via: "checkout" | "webhook",
): Promise<{ paid: boolean; appointmentId: string | null }> {
  const pay = await prisma.bookingPayment.findUnique({ where: { orderId } });
  if (!pay) return { paid: false, appointmentId: null };
  const claimed = await prisma.bookingPayment.updateMany({
    where: { id: pay.id, status: { in: ["created", "failed"] } },
    data: { status: "paid", paymentId, paidAt: new Date(), confirmedVia: via },
  });
  if (claimed.count === 0) return { paid: false, appointmentId: pay.appointmentId };
  await writeAudit({
    action: "appointment.payment",
    entityType: "appointment",
    entityId: pay.appointmentId,
    newValue: `₹${pay.amountPaise / 100} paid online`,
    meta: { orderId, paymentId, via },
  });
  return { paid: true, appointmentId: pay.appointmentId };
}

/// After an appointment's status changes: credit a paid deposit if it didn't happen, or
/// record the session for Billing if it did. Best-effort.
export async function billingAfterStatus(input: {
  appointmentId: string;
  to: string;
  cancelledBy?: "patient" | "clinic" | null;
  actor: Actor;
}): Promise<void> {
  try {
    if (input.to === "completed") await recordSession(input.appointmentId);
    else if (input.to === "no_show" || input.to === "cancelled") await creditDeposit(input.appointmentId, input.to, input.cancelledBy ?? null, input.actor);
  } catch (err) {
    logger.error(`billingAfterStatus failed for appointment ${input.appointmentId}: ${String(err)}`);
  }
}

/// Turn the paid deposit on a missed appointment into credit. One credit per payment.
export async function creditDeposit(
  appointmentId: string,
  to: string,
  cancelledBy: "patient" | "clinic" | null,
  actor: Actor,
): Promise<string | null> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      leadId: true,
      startAt: true,
      statusChangedAt: true,
      cancelReason: true,
      type: { select: { selfServiceCutoffHours: true } },
      payments: { where: { status: "paid" }, select: { id: true, amountPaise: true, currency: true, credit: { select: { id: true } } } },
    },
  });
  const pay = a?.payments.find((p) => !p.credit);
  if (!a || !pay) return null;
  const reason =
    to === "no_show"
      ? "no_show"
      : a.cancelReason === "Hold expired"
        ? "hold_lapsed"
        : cancelledBy === "clinic"
          ? "clinic_cancelled"
          : a.startAt.getTime() - (a.statusChangedAt ?? new Date()).getTime() < a.type.selfServiceCutoffHours * HOUR_MS
            ? "late_cancel"
            : "cancelled";
  const credit = await prisma.patientCredit
    .create({
      data: { leadId: a.leadId, amountPaise: pay.amountPaise, currency: pay.currency, paymentId: pay.id, appointmentId, reason },
      select: { id: true },
    })
    .catch(() => null); // unique paymentId: a concurrent status hook already made it
  if (!credit) return null;
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "lead.credit.add",
    entityType: "lead",
    entityId: a.leadId,
    newValue: `₹${pay.amountPaise / 100} credit`,
    reason: CREDIT_REASON_LABELS[reason] ?? reason,
    meta: { creditId: credit.id, appointmentId, paymentId: pay.id },
  });
  return credit.id;
}

export const CREDIT_REASON_LABELS: Record<string, string> = {
  no_show: "No-show",
  late_cancel: "Cancelled inside the cut-off",
  cancelled: "Cancelled in time",
  clinic_cancelled: "Cancelled by the clinic",
  hold_lapsed: "Paid, but the held slot lapsed",
};

/// Credit the patient can still use.
export async function availableCredits(leadId: string) {
  return prisma.patientCredit.findMany({
    where: { leadId, status: "available" },
    orderBy: { createdAt: "asc" },
    select: { id: true, amountPaise: true, reason: true, createdAt: true, appointmentId: true },
  });
}

/// Use a credit against a booking. The desk does this when the patient comes back.
export async function applyCredit(creditId: string, appointmentId: string, actor: Actor): Promise<{ ok: boolean; error?: string }> {
  const c = await prisma.patientCredit.findUnique({ where: { id: creditId } });
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { leadId: true } });
  if (!c || !a || c.leadId !== a.leadId) return { ok: false, error: "That credit isn't this patient's" };
  const r = await prisma.patientCredit.updateMany({
    where: { id: creditId, status: "available" },
    data: { status: "applied", appliedToId: appointmentId, appliedAt: new Date(), appliedById: actor.id ?? null },
  });
  if (r.count === 0) return { ok: false, error: "That credit has already been used or refunded" };
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "lead.credit.apply",
    entityType: "lead",
    entityId: c.leadId,
    newValue: `₹${c.amountPaise / 100} applied`,
    meta: { creditId, appointmentId },
  });
  return { ok: true };
}

/// A manager refunds a credit. `razorpay` issues the refund through Razorpay; `recorded`
/// notes a refund already made outside the CRM (bank transfer, the Razorpay dashboard).
export async function refundCredit(
  creditId: string,
  input: { reason: string; mode: "razorpay" | "recorded" },
  actor: Actor,
): Promise<{ ok: boolean; error?: string }> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, error: "A refund needs a reason" };
  const c = await prisma.patientCredit.findUnique({ where: { id: creditId }, include: { payment: true } });
  if (!c || c.status !== "available") return { ok: false, error: "Only unused credit can be refunded" };

  let ref = "recorded";
  if (input.mode === "razorpay") {
    if (!c.payment?.paymentId) return { ok: false, error: "No Razorpay payment to refund — record a manual refund instead" };
    const r = await refundRazorpayPayment(c.payment.paymentId, c.amountPaise, { creditId, reason: reason.slice(0, 200) });
    if (!r.ok) return { ok: false, error: `Razorpay refused the refund: ${r.error}` };
    ref = r.refundId;
  }
  const done = await prisma.patientCredit.updateMany({
    where: { id: creditId, status: "available" },
    data: { status: "refunded", refundedAt: new Date(), refundedById: actor.id ?? null, refundReason: reason, refundRef: ref },
  });
  if (done.count === 0) return { ok: false, error: "That credit changed while you were refunding it" };
  if (c.paymentId) await prisma.bookingPayment.update({ where: { id: c.paymentId }, data: { status: "refunded" } });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "lead.credit.refund",
    entityType: "lead",
    entityId: c.leadId,
    newValue: `₹${c.amountPaise / 100} refunded (${input.mode})`,
    reason,
    meta: { creditId, refundRef: ref },
  });
  return { ok: true };
}

/// A completed visit, for Billing. Session number and per-session value come from the
/// treatment plan when the visit is a plan step, else from the quote's quantity.
export async function recordSession(appointmentId: string): Promise<void> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      leadId: true,
      branchId: true,
      quoteId: true,
      completedAt: true,
      quote: { select: { totalPayable: true, quantity: true } },
      plannedStep: { select: { planId: true, plan: { select: { steps: { select: { appointmentId: true, status: true }, orderBy: { order: "asc" } } } } } },
    },
  });
  if (!a) return;
  let sessionNo: number | null = null;
  let sessions: number | null = null;
  const planId = a.plannedStep?.planId ?? null;
  if (a.plannedStep) {
    const counted = a.plannedStep.plan.steps.filter((s) => s.status !== "waived");
    sessions = counted.length;
    sessionNo = counted.findIndex((s) => s.appointmentId === appointmentId) + 1 || null;
  } else if (a.quoteId && a.quote) {
    sessions = a.quote.quantity;
    sessionNo = (await prisma.revenueEvent.count({ where: { quoteId: a.quoteId } })) + 1;
  }
  const amount = a.quote?.totalPayable != null && sessions ? Math.round(a.quote.totalPayable / sessions) : null;
  await prisma.revenueEvent
    .create({
      data: {
        appointmentId,
        leadId: a.leadId,
        quoteId: a.quoteId,
        planId,
        sessionNo,
        sessions,
        amount,
        branchId: a.branchId,
        occurredAt: a.completedAt ?? new Date(),
      },
    })
    .catch(() => {}); // one per appointment — a repeat is not an error
}
