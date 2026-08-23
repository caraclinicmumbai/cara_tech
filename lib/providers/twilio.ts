// Twilio click-to-call with recording (§3.1). When a rep takes a handover, we
// ring THEIR phone first; once they answer, our TwiML dials the lead, bridges the
// two, and records the call. Twilio posts the recording to our webhook, which
// stores it as a Call on the lead.
//
// Fail-safe: helpers log + return a result object; they never throw into the
// calling flow.
import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { dialablePhone } from "@/lib/phone";
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
///
/// Recording-consent disclosure (§compliance C1): the rep-facing `<Say>` isn't
/// heard by the patient (it plays before they're connected), so the `<Number url>`
/// points at a whisper TwiML that Twilio plays to the PATIENT when they answer —
/// disclosing the recording to them before the two legs bridge.
export function dialLeadTwiML(leadPhone: string, leadId: string, repId?: string): string {
  const base = publicBase();
  const cb =
    `${base}/api/webhooks/twilio/recording?leadId=${encodeURIComponent(leadId)}` +
    (repId ? `&repId=${encodeURIComponent(repId)}` : "");
  const from = process.env.TWILIO_CALLER_ID ?? "";
  const whisper = `${base}/api/twilio/whisper`;
  // Where Twilio reports how the dial ended. Without it, a leg that never connects
  // (wrong number, busy, no answer) just drops the rep into silence and the CRM
  // never learns the call happened — the recording callback only fires on success.
  const action =
    `${base}/api/twilio/dial-result?leadId=${encodeURIComponent(leadId)}` +
    (repId ? `&repId=${encodeURIComponent(repId)}` : "");
  const dialable = dialablePhone(leadPhone) ?? leadPhone;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>Connecting you to the patient now. This call is recorded.</Say>` +
    `<Dial callerId="${xmlEscape(from)}" record="record-from-answer-dual" ` +
    `action="${xmlEscape(action)}" method="POST" ` +
    `recordingStatusCallback="${xmlEscape(cb)}" recordingStatusCallbackEvent="completed">` +
    `<Number url="${xmlEscape(whisper)}">${xmlEscape(dialable)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/// Spoken to the rep when the patient leg didn't connect, in place of the silence
/// they used to get. `status` is Twilio's DialCallStatus; a call that DID connect
/// just hangs up quietly (the two of them have already said their goodbyes).
export function dialFailedTwiML(status: string): string {
  const reason =
    status === "busy"
      ? "The patient's number is busy."
      : status === "no-answer"
        ? "The patient did not answer."
        : status === "failed"
          ? "That number could not be reached. Please check it on the lead."
          : status === "completed" || status === "answered"
            ? null
            : "The call has ended.";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>${reason ? `<Say>${xmlEscape(reason)}</Say>` : ""}<Hangup/></Response>`
  );
}

/// The recording-disclosure whisper played to the PATIENT (callee) when they answer
/// a human-handover call, before the two legs bridge (§compliance C1).
export function recordingWhisperTwiML(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>This call is recorded for quality and training purposes.</Say>` +
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

/// Delete a recording's audio from Twilio's servers (§compliance C3 — erasure /
/// retention). Our DB row is dropped separately; this removes the actual media so
/// PII doesn't linger on the provider. The recording SID (RE…) is parsed from the
/// stored URL. Best-effort: returns true on success or if already gone (404).
export async function deleteTwilioRecording(recordingUrl: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return false;
  const match = recordingUrl.match(/(RE[0-9a-fA-F]{32})/);
  if (!match) {
    logger.warn(`Twilio recording delete: no SID in URL ${recordingUrl}`);
    return false;
  }
  try {
    await axios.delete(`${API}/Accounts/${sid}/Recordings/${match[1]}.json`, {
      auth: { username: sid, password: token },
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return true; // already gone
    logger.error(`Twilio recording delete failed (${match[1]}): ${String(err)}`);
    return false;
  }
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

// ── Inbound calls to the published clinic number (§presence) ──────────────────
// The Voice webhook on that number answers, greets, and bridges the caller to the
// counsellor chosen by lib/inboundRouting.ts. WHO to ring is decided there; these
// helpers only render the call control.

/// The clinic number patients dial. Used as the caller ID on the rep's leg, so an
/// inbound patient call shows as "the clinic" rather than the patient's own number
/// (the whisper names the patient instead). Falls back to the webhook's To.
export function inboundCallerId(to?: string | null): string {
  return process.env.TWILIO_INBOUND_NUMBER ?? to ?? process.env.TWILIO_CALLER_ID ?? "";
}

const GREETING =
  process.env.CLINIC_CALL_GREETING ??
  "Thank you for calling. Please hold while we connect you to a counsellor. This call may be recorded for quality and training purposes.";

/// Ring one counsellor. `action` is fetched when the leg ends for ANY reason
/// (no answer, busy, or a completed conversation), which is what drives the
/// fall-through ladder. `whisperUrl` plays to the counsellor only.
export function inboundDialRepTwiML(opts: {
  repPhone: string;
  callerId: string;
  whisperUrl: string;
  actionUrl: string;
  recordingCallbackUrl: string;
  timeoutSec: number;
  greet: boolean;
}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    (opts.greet ? `<Say>${xmlEscape(GREETING)}</Say>` : "") +
    `<Dial timeout="${opts.timeoutSec}" callerId="${xmlEscape(opts.callerId)}" ` +
    `action="${xmlEscape(opts.actionUrl)}" method="POST" ` +
    `record="record-from-answer-dual" ` +
    `recordingStatusCallback="${xmlEscape(opts.recordingCallbackUrl)}" ` +
    `recordingStatusCallbackEvent="completed">` +
    `<Number url="${xmlEscape(opts.whisperUrl)}">${xmlEscape(opts.repPhone)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/// Played to the COUNSELLOR when they pick up, before the caller is bridged — so they
/// know who is on the line and whether this is their own patient calling back.
export function inboundWhisperTwiML(patientName: string, sticky: boolean): string {
  const who = sticky ? "Your patient" : "Patient";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>${xmlEscape(`${who} ${patientName} is calling the clinic. Connecting now.`)}</Say>` +
    `</Response>`
  );
}

/// Nobody free on the first pass: hold the caller briefly and try again. A counsellor
/// finishing a call in the next half-minute picks this up rather than the caller being
/// dropped to voicemail the instant everyone happens to be busy.
export function inboundHoldTwiML(retryUrl: string, holdSec: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>All our counsellors are with patients right now. Please hold for a moment.</Say>` +
    `<Pause length="${holdSec}"/>` +
    `<Redirect method="POST">${xmlEscape(retryUrl)}</Redirect>` +
    `</Response>`
  );
}

/// Last resort — take a message. The recording callback files it against the lead and
/// puts a "return this call" step on the owner's roadmap.
export function inboundVoicemailTwiML(recordActionUrl: string, maxSec = 120): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say>We are sorry to keep you waiting. Please leave your name and message after the tone, ` +
    `and a counsellor will call you back.</Say>` +
    `<Record maxLength="${maxSec}" playBeep="true" trim="trim-silence" timeout="5" ` +
    `action="${xmlEscape(recordActionUrl)}" method="POST" ` +
    `recordingStatusCallback="${xmlEscape(recordActionUrl)}" recordingStatusCallbackEvent="completed"/>` +
    `<Say>Thank you. We will call you back shortly. Goodbye.</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}
