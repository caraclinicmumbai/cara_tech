// One-time codes for patient-facing flows (§2.3 "mobile number verified by OTP —
// reduces fake bookings"; reused by intake forms, §2.7).
//
// Delivery, in order:
//   1. WhatsApp AUTHENTICATION template — `WHATSAPP_OTP_TEMPLATE` (approved in Meta,
//      body {{1}} = the code, with a copy-code button).
//   2. SMS — needs DLT: `PLIVO_OTP_DLT_TEMPLATE_ID`, text "{code} is your Cara Clinic
//      verification code. It is valid for 10 minutes." registered exactly.
//   3. Development only (NODE_ENV !== "production"): the code is returned to the caller
//      so the widget can be tested locally. In production there is no such path —
//      no channel means no booking, never a bypass.
//
// Only a hash of the code is stored; 10-minute expiry, 5 attempts, 3 sends per phone
// per 15 minutes. A successful check returns a signed "verified phone" token that the
// next step presents instead of trusting a phone number from the browser.
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rateLimit";
import { dialablePhone } from "@/lib/phone";
import { isWhatsAppConfigured, sendWhatsAppTemplate } from "@/lib/providers/whatsapp";
import { isSmsConfigured, sendSms } from "@/lib/providers/sms";

const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

function hash(code: string, phone: string): string {
  return createHash("sha256").update(`${phone}:${code}:${process.env.AUTH_SECRET ?? ""}`).digest("hex");
}

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

export function otpChannelAvailable(): "whatsapp" | "sms" | "dev" | null {
  if (isWhatsAppConfigured() && process.env.WHATSAPP_OTP_TEMPLATE) return "whatsapp";
  if (isSmsConfigured() && process.env.PLIVO_OTP_DLT_TEMPLATE_ID) return "sms";
  if (process.env.NODE_ENV !== "production") return "dev";
  return null;
}

export type IssueResult = { ok: true; channel: string; devCode?: string } | { ok: false; error: string };

export async function issueOtp(phoneRaw: string, purpose: string, ip: string): Promise<IssueResult> {
  const phone = dialablePhone(phoneRaw);
  if (!phone) return { ok: false, error: "Enter a valid mobile number" };
  const [byPhone, byIp] = await Promise.all([rateLimit(`otp:${purpose}:${phone}`, 3, 900), rateLimit(`otp-ip:${ip}`, 10, 900)]);
  if (!byPhone.ok || !byIp.ok) return { ok: false, error: "Too many codes requested — please wait a few minutes." };
  const channel = otpChannelAvailable();
  if (!channel) return { ok: false, error: "We can't send a code right now — please call the clinic to book." };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.otpChallenge.create({
    data: { phone, purpose, codeHash: hash(code, phone), expiresAt: new Date(Date.now() + TTL_MS), channel },
  });

  if (channel === "whatsapp") {
    const r = await sendWhatsAppTemplate(phone, process.env.WHATSAPP_OTP_TEMPLATE!, process.env.WHATSAPP_OTP_LANGUAGE ?? "en", [
      { type: "body", parameters: [{ type: "text", text: code }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
    ]);
    if (!r.ok) return { ok: false, error: "We couldn't send the code on WhatsApp — please try again." };
  } else if (channel === "sms") {
    const r = await sendSms(phone, `${code} is your Cara Clinic verification code. It is valid for 10 minutes.`, process.env.PLIVO_OTP_DLT_TEMPLATE_ID);
    if (!r.ok) return { ok: false, error: "We couldn't send the code by SMS — please try again." };
  } else {
    logger.warn(`DEV OTP for ${phone} (${purpose}): ${code}`);
    return { ok: true, channel, devCode: code };
  }
  return { ok: true, channel };
}

/// Check a code. On success returns a signed token proving this phone was verified
/// for this purpose, valid 30 minutes.
export async function verifyOtp(phoneRaw: string, purpose: string, code: string): Promise<{ ok: true; token: string; phone: string } | { ok: false; error: string }> {
  const phone = dialablePhone(phoneRaw);
  if (!phone) return { ok: false, error: "Enter a valid mobile number" };
  const ch = await prisma.otpChallenge.findFirst({
    where: { phone, purpose, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!ch) return { ok: false, error: "That code has expired — request a new one." };
  if (ch.attempts >= MAX_ATTEMPTS) return { ok: false, error: "Too many wrong attempts — request a new code." };
  await prisma.otpChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
  const a = Buffer.from(hash(code.trim(), phone));
  const b = Buffer.from(ch.codeHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "That code isn't right." };
  await prisma.otpChallenge.update({ where: { id: ch.id }, data: { verifiedAt: new Date() } });
  return { ok: true, token: signVerified(phone, purpose), phone };
}

function signVerified(phone: string, purpose: string): string {
  const exp = Math.floor((Date.now() + 30 * 60_000) / 1000).toString(36);
  const payload = `${phone}|${purpose}|${exp}`;
  const sig = createHmac("sha256", secret()).update(`otp-verified:${payload}`).digest("base64url").slice(0, 32);
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/// The phone a verified-phone token vouches for, or null.
export function readVerified(token: string, purpose: string): string | null {
  const [p64, sig] = token.split(".");
  if (!p64 || !sig) return null;
  const payload = Buffer.from(p64, "base64url").toString();
  const expected = createHmac("sha256", secret()).update(`otp-verified:${payload}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [phone, p, exp36] = payload.split("|");
  if (p !== purpose || parseInt(exp36, 36) * 1000 < Date.now()) return null;
  return phone;
}
