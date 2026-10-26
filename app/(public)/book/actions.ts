"use server";

// Public actions for the online booking widget (§2.3). No login — so every one is
// rate-limited, validates its own inputs, and trusts nothing from the browser that it
// can't verify: the slot is proven by a signed hold token, the phone by a signed
// verified-phone token from the OTP step.
import { headers } from "next/headers";
import { rateLimit } from "@/lib/rateLimit";
import { issueOtp, readVerified, verifyOtp } from "@/lib/scheduling/otp";
import {
  completeBooking,
  confirmPayment,
  existingPatient,
  holdSlot,
  onlineSlots,
  releaseHold,
  type CompleteResult,
  type OnlineSlot,
} from "@/lib/scheduling/online";

async function client() {
  const h = await headers();
  return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown", ua: h.get("user-agent") ?? "" };
}

async function limited(key: string, n: number, sec: number): Promise<boolean> {
  const { ip } = await client();
  return !(await rateLimit(`book:${key}:${ip}`, n, sec)).ok;
}

export async function slotsAction(p: { typeId: string; branchId: string; doctorId: string; dateKey: string }): Promise<OnlineSlot[]> {
  if (await limited("slots", 120, 600)) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dateKey)) return [];
  return onlineSlots({ typeId: p.typeId, branchId: p.branchId, doctorId: p.doctorId === "none" ? null : (p.doctorId || "any"), dateKey: p.dateKey });
}

export async function holdAction(p: { typeId: string; branchId: string; doctorId: string | null; startAt: string; previous?: string | null; website?: string }) {
  if (p.website) return { ok: false as const, error: "Something went wrong." }; // honeypot
  if (await limited("hold", 20, 600)) return { ok: false as const, error: "Too many attempts — please wait a few minutes." };
  if (p.previous) await releaseHold(p.previous);
  return holdSlot({ typeId: p.typeId, branchId: p.branchId, doctorId: p.doctorId, startAt: p.startAt });
}

export async function sendCodeAction(phone: string) {
  const { ip } = await client();
  return issueOtp(phone, "online_booking", ip);
}

export async function verifyCodeAction(phone: string, code: string) {
  if (await limited("verify", 20, 600)) return { ok: false as const, error: "Too many attempts — please wait a few minutes." };
  return verifyOtp(phone, "online_booking", code);
}

/// For existing-patient services: is this verified phone a patient, and whose? The
/// widget then offers only their surgeon's times.
export async function existingPatientAction(verifiedToken: string): Promise<{ ok: boolean; doctorId?: string | null; error?: string }> {
  const phone = readVerified(verifiedToken, "online_booking");
  if (!phone) return { ok: false, error: "Please verify your number again." };
  const e = await existingPatient(phone);
  if (!e) return { ok: false, error: "We couldn't find you as an existing patient. Please book a consultation instead." };
  return { ok: true, doctorId: e.doctorId };
}

export async function completeAction(p: {
  holdToken: string;
  verifiedToken: string;
  name: string;
  email: string;
  consentMessages: boolean;
  consentMarketing: boolean;
  payOnline: boolean;
  utm: { source?: string; medium?: string; campaign?: string; content?: string };
  website?: string;
}): Promise<CompleteResult> {
  if (p.website) return { ok: false, error: "Something went wrong." };
  if (await limited("complete", 10, 600)) return { ok: false, error: "Too many attempts — please wait a few minutes." };
  const phone = readVerified(p.verifiedToken, "online_booking");
  if (!phone) return { ok: false, error: "Please verify your mobile number again." };
  const { ip, ua } = await client();
  return completeBooking({
    holdToken: p.holdToken,
    phone,
    name: p.name.slice(0, 120),
    email: p.email.slice(0, 200),
    consentMessages: p.consentMessages,
    consentMarketing: p.consentMarketing,
    payOnline: p.payOnline,
    utm: p.utm,
    ip,
    userAgent: ua,
  });
}

export async function paymentAction(p: { holdToken: string; orderId: string; paymentId: string; signature: string }): Promise<CompleteResult> {
  if (await limited("pay", 10, 600)) return { ok: false, error: "Too many attempts." };
  return confirmPayment(p);
}
