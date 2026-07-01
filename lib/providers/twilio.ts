// Twilio click-to-call with recording (§3.1). When a rep takes a handover, we
// ring THEIR phone first; once they answer, our TwiML dials the lead, bridges the
// two, and records the call. Twilio posts the recording to our webhook, which
// stores it as a Call on the lead.
//
// Fail-safe: helpers log + return a result object; they never throw into the
// calling flow.
import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";

const API = "https://api.twilio.com/2010-04-01";

export function isTwilioConfigured(): boolean {
  return (
    !!process.env.TWILIO_ACCOUNT_SID &&
    !!process.env.TWILIO_AUTH_TOKEN &&
    !!process.env.TWILIO_CALLER_ID
  );
}

/// Public base URL Twilio should call back on (prod domain). Falls back to NEXTAUTH_URL.
export function publicBase(): string {
  return (process.env.TWILIO_PUBLIC_BASE ?? process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
}

export type ClickToCallResult = { ok: true; sid: string } | { ok: false; error: string };

/// Start a recorded click-to-call: ring `repPhone`; on answer Twilio fetches our
/// TwiML (which dials the lead + records). `repId` (the rep who initiated it) is
/// threaded through the callback URLs so the recording is attributed to them.
/// Returns the parent call SID.
export async function clickToCall(repPhone: string, leadId: string, repId?: string): Promise<ClickToCallResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_CALLER_ID;
  if (!sid || !token || !from) return { ok: false, error: "Twilio not configured" };
  const base = publicBase();
  if (!base) return { ok: false, error: "No public base URL (set TWILIO_PUBLIC_BASE or NEXTAUTH_URL)" };

  try {
    const voiceUrl = `${base}/api/twilio/voice/${leadId}${repId ? `?repId=${encodeURIComponent(repId)}` : ""}`;
    const body = new URLSearchParams({
      To: repPhone,
      From: from,
      Url: voiceUrl,
    });
    const res = await axios.post(`${API}/Accounts/${sid}/Calls.json`, body, {
      auth: { username: sid, password: token },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15_000,
    });
    return { ok: true, sid: res.data?.sid ?? "" };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    logger.error(`Twilio click-to-call failed (lead ${leadId}): ${detail}`);
    return { ok: false, error: detail };
  }
}

/// Escape a value for safe embedding in XML (attribute or text). Critically, the
/// recording-callback URL carries a `leadId=…&repId=…` query string, and a raw `&`
/// makes the TwiML invalid — Twilio then plays "an application error has occurred"
/// to the rep instead of dialing the lead.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/// TwiML returned when the rep answers: announce, then dial + record the lead.
/// The recording completion is POSTed to our webhook with the leadId (and the
/// handling rep's id, when known, so the recording is attributed to them).
export function dialLeadTwiML(leadPhone: string, leadId: string, repId?: string): string {
  const base = publicBase();
  const cb =
    `${base}/api/webhooks/twilio/recording?leadId=${encodeURIComponent(leadId)}` +
    (repId ? `&repId=${encodeURIComponent(repId)}` : "");
  const from = process.env.TWILIO_CALLER_ID ?? "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>Connecting you to the patient now. This call is recorded.</Say>` +
    `<Dial callerId="${xmlEscape(from)}" record="record-from-answer-dual" ` +
    `recordingStatusCallback="${xmlEscape(cb)}" recordingStatusCallbackEvent="completed">` +
    `<Number>${xmlEscape(leadPhone)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/// Verify Twilio's X-Twilio-Signature: HMAC-SHA1 of (full URL + sorted POST
/// params concatenated) with the auth token, base64. `url` MUST be the exact
/// public URL Twilio called (incl. query string).
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/// Fetch a Twilio recording's audio (Basic-auth'd) for the in-CRM player.
export async function fetchTwilioRecording(
  recordingUrl: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const res = await axios.get<ArrayBuffer>(recordingUrl, {
      auth: { username: sid, password: token },
      responseType: "arraybuffer",
      timeout: 20_000,
    });
    return { buffer: Buffer.from(res.data), mime: "audio/mpeg" };
  } catch (err) {
    logger.error(`Twilio recording fetch failed: ${String(err)}`);
    return null;
  }
}
