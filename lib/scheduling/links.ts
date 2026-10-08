// The patient's secure link to their appointment (§2.4 "a secure, expiring link to
// confirm / reschedule / cancel"). No login, so the link IS the credential: an HMAC over
// the appointment id and an expiry, signed with the app secret. Nothing is stored — a
// tampered or expired link simply fails to verify. It expires when the appointment ends;
// a rescheduled appointment gets a new id and therefore a new link (the old one shows
// where the appointment moved to).
import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set — patient links can't be signed");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`appt-link:${payload}`).digest("base64url").slice(0, 32);
}

export function appointmentToken(appointmentId: string, expiresAt: Date): string {
  const payload = `${appointmentId}.${Math.floor(expiresAt.getTime() / 1000).toString(36)}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAppointmentToken(token: string, now = new Date()): { appointmentId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, exp36, sig] = parts;
  const expected = sign(`${id}.${exp36}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = parseInt(exp36, 36) * 1000;
  if (!Number.isFinite(exp) || exp < now.getTime()) return null;
  return { appointmentId: id };
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function appointmentLink(appointmentId: string, endAt: Date): string {
  return `${appBaseUrl()}/a/${appointmentToken(appointmentId, endAt)}`;
}
