// Online booking (§2.3) — the service behind the public widget at /book. Patients pick
// branch → service → doctor (or any) → time; the slot is held; they give their details
// and verify their mobile by OTP; the booking is confirmed (optionally after paying
// online at a discount, consultations only).
//
// The same engine as the front desk decides what's free, with stricter rules for the
// public: only online-bookable types, at least `minNotice` hours away, at most `maxDays`
// ahead, and NEVER a time that would overbook a doctor or a machine — a warning a
// receptionist can acknowledge is simply not offered online.
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { getBoolSetting, getNumberSetting } from "@/lib/settings";
import { advanceStage } from "@/lib/leadStages";
import { findLeadByPhone } from "@/lib/messages";
import { createRazorpayOrder, isRazorpayConfigured, razorpayKeyId, verifyRazorpayPayment } from "@/lib/providers/razorpay";
import { bookAppointment, changeAppointmentStatus, findSlots } from "@/lib/scheduling/booking";
import { ONLINE_BOOKING, ONLINE_HOLD_MINUTES, ONLINE_MAX_DAYS, ONLINE_MIN_NOTICE_HOURS } from "@/lib/scheduling/toggles";
import { istDateKey, istInstant } from "@/lib/scheduling/time";
import { appointmentLink } from "@/lib/scheduling/links";

const ONLINE = { id: null, email: "patient (online booking)" };

export async function onlineSettings() {
  const [enabled, minNoticeHours, maxDays, holdMinutes] = await Promise.all([
    getBoolSetting(ONLINE_BOOKING),
    getNumberSetting(ONLINE_MIN_NOTICE_HOURS),
    getNumberSetting(ONLINE_MAX_DAYS),
    getNumberSetting(ONLINE_HOLD_MINUTES),
  ]);
  return { enabled, minNoticeHours, maxDays, holdMinutes };
}

export type OnlineType = {
  id: string;
  name: string;
  category: string | null;
  durationMin: number;
  audience: "anyone" | "existing";
  needsDoctor: boolean;
  fee: number | null;
  prepay: { discountPct: number; payPaise: number; listPaise: number } | null;
};

/// What the widget can offer: active branches, online-bookable types, active doctors.
export async function onlineCatalog() {
  const [branches, types, doctors] = await Promise.all([
    prisma.branch.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true, city: true } }),
    prisma.appointmentType.findMany({
      where: { active: true, onlineBookable: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      include: { requirements: { select: { kind: true, resourceId: true } } },
    }),
    prisma.resource.findMany({ where: { kind: "doctor", active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, subtype: true } }),
  ]);
  const razorpay = isRazorpayConfigured();
  return {
    branches,
    doctors,
    types: types.map<OnlineType>((t) => {
      const listPaise = (t.onlineFee ?? 0) * 100;
      const discount = Math.min(Math.max(t.prepayDiscountPct ?? 0, 0), 90);
      return {
        id: t.id,
        name: t.name,
        category: t.category,
        durationMin: t.durationMin,
        audience: t.onlineAudience === "existing" ? "existing" : "anyone",
        needsDoctor: t.requirements.some((r) => r.kind === "doctor" && !r.resourceId),
        fee: t.onlineFee,
        prepay:
          razorpay && t.onlinePrepay && listPaise > 0
            ? { discountPct: discount, listPaise, payPaise: Math.round((listPaise * (100 - discount)) / 100) }
            : null,
      };
    }),
  };
}

export type OnlineSlot = { startAt: string; endAt: string; doctorId: string | null; doctorName: string | null };

/// Free times on one day. doctorId: a specific doctor, "any" (every doctor's slots,
/// merged — the booking still lands on that slot's NAMED doctor, §2.1.d), or null for a
/// type that needs no doctor.
export async function onlineSlots(params: { typeId: string; branchId: string; doctorId: string | "any" | null; dateKey: string }): Promise<OnlineSlot[]> {
  const s = await onlineSettings();
  if (!s.enabled) return [];
  const type = await prisma.appointmentType.findFirst({
    where: { id: params.typeId, active: true, onlineBookable: true },
    include: { requirements: { select: { kind: true, resourceId: true } } },
  });
  if (!type) return [];
  const today = istDateKey(new Date());
  const lastDay = istDateKey(new Date(Date.now() + s.maxDays * 86_400_000));
  if (params.dateKey < today || params.dateKey > lastDay) return [];
  const earliest = Date.now() + s.minNoticeHours * 3_600_000;
  const needsDoctor = type.requirements.some((r) => r.kind === "doctor" && !r.resourceId);

  const doctors = !needsDoctor
    ? [null]
    : params.doctorId && params.doctorId !== "any"
      ? await prisma.resource.findMany({ where: { id: params.doctorId, kind: "doctor", active: true }, select: { id: true, name: true } })
      : await prisma.resource.findMany({ where: { kind: "doctor", active: true }, select: { id: true, name: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });

  const byStart = new Map<string, OnlineSlot>();
  for (const d of doctors) {
    const slots = await findSlots({
      branchId: params.branchId,
      typeId: type.id,
      dateKey: params.dateKey,
      resourceIds: d ? [d.id] : [],
      excludeNeedsAck: true,
    });
    for (const sl of slots) {
      if (sl.startAt.getTime() < earliest) continue;
      const key = sl.startAt.toISOString();
      if (!byStart.has(key)) byStart.set(key, { startAt: key, endAt: sl.endAt.toISOString(), doctorId: d?.id ?? null, doctorName: d?.name ?? null });
    }
  }
  return [...byStart.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

// ── The hold token: proves the browser holds THIS slot ──────────────────────

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}
function holdToken(appointmentId: string): string {
  const sig = createHmac("sha256", secret()).update(`online-hold:${appointmentId}`).digest("base64url").slice(0, 32);
  return `${appointmentId}.${sig}`;
}
function readHold(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig) return null;
  const expected = createHmac("sha256", secret()).update(`online-hold:${id}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export async function holdSlot(params: { typeId: string; branchId: string; doctorId: string | null; startAt: string }): Promise<
  { ok: true; holdToken: string; expiresAt: string } | { ok: false; error: string }
> {
  const s = await onlineSettings();
  if (!s.enabled) return { ok: false, error: "Online booking is closed — please call the clinic." };
  const type = await prisma.appointmentType.findFirst({ where: { id: params.typeId, active: true, onlineBookable: true }, select: { id: true } });
  if (!type) return { ok: false, error: "That service can't be booked online." };
  const startAt = new Date(params.startAt);
  if (Number.isNaN(startAt.getTime()) || startAt.getTime() < Date.now() + s.minNoticeHours * 3_600_000) {
    return { ok: false, error: "Please pick a later time." };
  }
  const r = await bookAppointment(
    {
      leadId: "",
      onlineHold: true,
      holdMinutes: s.holdMinutes,
      branchId: params.branchId,
      typeId: params.typeId,
      startAt,
      resourceIds: params.doctorId ? [params.doctorId] : [],
      source: "online",
    },
    ONLINE,
  );
  if (!r.ok) return { ok: false, error: r.justTaken ? "Someone just took that time — please pick another." : "That time is no longer free — please pick another." };
  // Online never accepts an overbooking warning (excluded from the slot list, and
  // refused here if the picture changed since).
  if (r.warnings.some((w) => w.needsAck)) {
    await changeAppointmentStatus(r.appointmentId, "cancelled", { reason: "Online hold needed a warning acknowledged", cancelledBy: "clinic" }, ONLINE);
    return { ok: false, error: "That time is no longer free — please pick another." };
  }
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId }, select: { holdExpiresAt: true } });
  return { ok: true, holdToken: holdToken(r.appointmentId), expiresAt: a.holdExpiresAt!.toISOString() };
}

/// Release a hold the patient walked away from (changed their mind, picked another).
export async function releaseHold(token: string): Promise<void> {
  const id = readHold(token);
  if (!id) return;
  const a = await prisma.appointment.findUnique({ where: { id }, select: { status: true } });
  if (a?.status === "tentative") await changeAppointmentStatus(id, "cancelled", { reason: "Released by patient", cancelledBy: "patient" }, ONLINE);
}

// ── Existing patients (2.3.a / 2.3.c) ────────────────────────────────────────

/// Is this phone an existing patient — someone with a completed appointment or a
/// treatment journey — and who is their surgeon? Follow-ups book THEIR doctor.
export async function existingPatient(phone: string): Promise<{ leadId: string; doctorId: string | null } | null> {
  const lead = await findLeadByPhone(phone);
  if (!lead) return null;
  const lastDone = await prisma.appointment.findFirst({
    where: { leadId: lead.id, status: "completed" },
    orderBy: { startAt: "desc" },
    include: { resources: { include: { resource: { select: { id: true, kind: true } } } } },
  });
  const journey = await prisma.postSalesJourney.findFirst({ where: { leadId: lead.id }, orderBy: { openedAt: "desc" }, select: { doctorId: true } });
  if (!lastDone && !journey) return null;
  let doctorId = lastDone?.resources.find((r) => r.resource.kind === "doctor")?.resource.id ?? null;
  if (!doctorId && journey?.doctorId) {
    const res = await prisma.resource.findUnique({ where: { userId: journey.doctorId }, select: { id: true } });
    doctorId = res?.id ?? null;
  }
  return { leadId: lead.id, doctorId };
}

// ── Completing a booking ────────────────────────────────────────────────────

export const CONSENT_TEXT = {
  appointment_messages: {
    version: "2026-10-08",
    text: "Cara Clinic may send me WhatsApp and SMS messages about this appointment — confirmation, reminders and changes.",
  },
  marketing: {
    version: "2026-10-08",
    text: "Cara Clinic may send me offers and updates about treatments. I can stop these any time by replying STOP.",
  },
} as const;

/// Ad platform → lead source (the attribution reports already know these).
function sourceFromUtm(utmSource: string | null | undefined): "instagram" | "facebook" | "google" | "web_form" {
  const s = (utmSource ?? "").toLowerCase();
  if (/insta|^ig/.test(s)) return "instagram";
  if (/facebook|^fb|meta/.test(s)) return "facebook";
  if (/google|adwords|gads/.test(s)) return "google";
  return "web_form";
}

export type CompleteInput = {
  holdToken: string;
  phone: string; // from the verified-phone token, never from the browser
  name: string;
  email?: string | null;
  consentMessages: boolean;
  consentMarketing: boolean;
  utm?: { source?: string | null; medium?: string | null; campaign?: string | null; content?: string | null };
  payOnline?: boolean;
  ip?: string | null;
  userAgent?: string | null;
};

export type CompleteResult =
  | { ok: true; done: true; appointmentId: string; link: string }
  | { ok: true; done: false; payment: { keyId: string; orderId: string; amountPaise: number; name: string; description: string; prefill: { name: string; contact: string; email?: string } } }
  | { ok: false; error: string };

export async function completeBooking(input: CompleteInput): Promise<CompleteResult> {
  const id = readHold(input.holdToken);
  if (!id) return { ok: false, error: "Your session expired — please pick a time again." };
  const appt = await prisma.appointment.findUnique({
    where: { id },
    include: { type: true, branch: { select: { name: true } } },
  });
  if (!appt || appt.status !== "tentative") return { ok: false, error: "Your held time expired — please pick a time again." };
  if (appt.holdExpiresAt && appt.holdExpiresAt < new Date()) return { ok: false, error: "Your held time expired — please pick a time again." };
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Please enter your name." };
  if (!input.consentMessages) return { ok: false, error: "Please allow messages about this appointment, so we can confirm it with you." };

  // Existing-patient-only types: must be an existing patient.
  if (appt.type.onlineAudience === "existing" && !(await existingPatient(input.phone))) {
    return { ok: false, error: "This is for existing patients. Please book a consultation instead." };
  }

  // Match or create the person (§3.1 duplicate detection — by phone).
  let lead = await findLeadByPhone(input.phone);
  const utm = input.utm ?? {};
  if (lead && lead.deletedAt) lead = null; // never attach to a trashed record
  if (!lead) {
    lead = await prisma.lead.create({
      data: {
        name,
        phone: input.phone,
        email: input.email?.trim() || null,
        source: sourceFromUtm(utm.source),
        campaign: utm.campaign?.slice(0, 200) || null,
        adId: utm.content?.slice(0, 200) || null,
        interest: appt.type.name,
        status: "confirmed",
        stage: "appointment_scheduled",
        stageChangedAt: new Date(),
        consentMethod: "digital_form",
        consentAt: new Date(),
      },
    });
    await writeAudit({ action: "lead.create", entityType: "lead", entityId: lead.id, newValue: `${name} (online booking)`, meta: { utm } });
  } else {
    const next = advanceStage(lead.stage, "appointment_scheduled");
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        ...(next ? { stage: next, stageChangedAt: new Date() } : {}),
        ...(!lead.email && input.email?.trim() ? { email: input.email.trim() } : {}),
      },
    });
  }

  // Consents — one row per purpose, with the exact wording (DPDP).
  await prisma.consentRecord.createMany({
    data: (["appointment_messages", "marketing"] as const).map((purpose) => ({
      leadId: lead!.id,
      purpose,
      granted: purpose === "marketing" ? input.consentMarketing : input.consentMessages,
      text: CONSENT_TEXT[purpose].text,
      version: CONSENT_TEXT[purpose].version,
      source: "online_booking",
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    })),
  });

  // Move the held slot onto the patient.
  await prisma.appointment.update({ where: { id }, data: { leadId: lead.id, notes: "Booked online" } });

  // Pay online (consultations, at a discount)?
  const cat = await onlineCatalog();
  const t = cat.types.find((x) => x.id === appt.typeId);
  if (input.payOnline && t?.prepay) {
    const order = await createRazorpayOrder(t.prepay.payPaise, `appt_${id}`, { appointmentId: id, leadId: lead.id });
    if (!order.ok) return { ok: false, error: "Online payment isn't working right now — you can book and pay at the clinic." };
    await prisma.bookingPayment.create({
      data: { appointmentId: id, amountPaise: t.prepay.payPaise, listPaise: t.prepay.listPaise, discountPct: t.prepay.discountPct, orderId: order.orderId },
    });
    // Give them time to pay.
    await prisma.appointment.update({ where: { id }, data: { holdExpiresAt: new Date(Date.now() + 15 * 60_000) } });
    return {
      ok: true,
      done: false,
      payment: {
        keyId: razorpayKeyId(),
        orderId: order.orderId,
        amountPaise: t.prepay.payPaise,
        name: "Cara Clinic",
        description: `${appt.type.name} — ${appt.branch.name}`,
        prefill: { name, contact: input.phone, ...(input.email ? { email: input.email } : {}) },
      },
    };
  }

  return finalise(id);
}

/// Hold → booked (reminders start, via the status hook) and hand back the link.
async function finalise(id: string): Promise<CompleteResult> {
  const r = await changeAppointmentStatus(id, "booked", {}, ONLINE);
  if (!r.ok) return { ok: false, error: "Your held time expired — please pick a time again." };
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { endAt: true } });
  logger.info(`Online booking confirmed: ${id}`);
  return { ok: true, done: true, appointmentId: id, link: appointmentLink(id, a.endAt) };
}

export async function confirmPayment(input: { holdToken: string; orderId: string; paymentId: string; signature: string }): Promise<CompleteResult> {
  const id = readHold(input.holdToken);
  if (!id) return { ok: false, error: "Your session expired." };
  const pay = await prisma.bookingPayment.findUnique({ where: { orderId: input.orderId } });
  if (!pay || pay.appointmentId !== id) return { ok: false, error: "Payment not found." };
  if (!verifyRazorpayPayment(input.orderId, input.paymentId, input.signature)) {
    await prisma.bookingPayment.update({ where: { id: pay.id }, data: { status: "failed" } });
    return { ok: false, error: "We couldn't verify the payment. If money was taken, the clinic will sort it out — please call." };
  }
  await prisma.bookingPayment.update({ where: { id: pay.id }, data: { status: "paid", paymentId: input.paymentId, paidAt: new Date() } });
  await writeAudit({ action: "appointment.payment", entityType: "appointment", entityId: id, newValue: `₹${pay.amountPaise / 100} paid online`, meta: { orderId: input.orderId, paymentId: input.paymentId } });
  const done = await finalise(id);
  if (done.ok && done.done) await changeAppointmentStatus(id, "confirmed", {}, ONLINE); // paid = confirmed
  return done;
}

/// Dates the widget's date strip should offer.
export async function bookableDates(): Promise<string[]> {
  const s = await onlineSettings();
  const out: string[] = [];
  const start = istInstant(istDateKey(new Date()), 12 * 60);
  for (let i = 0; i < Math.min(s.maxDays, 90); i++) out.push(istDateKey(new Date(start.getTime() + i * 86_400_000)));
  return out;
}
