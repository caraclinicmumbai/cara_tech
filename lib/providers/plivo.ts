// Plivo click-to-call with recording — the Indian-caller-ID replacement for Twilio (§3.1).
//
// Same two-leg shape as the Twilio provider: ring the COUNSELLOR, and when they answer our
// XML dials the patient, bridges them and records. What differs is Plivo-specific and worth
// stating, because each one is a place a faithful port would go wrong:
//
//   • `<Dial>` CANNOT record. Twilio's `record="record-from-answer-dual"` has no equivalent
//     attribute here; recording a bridged call is a separate `<Record>` element placed
//     BEFORE the `<Dial>`, with `recordSession` + `startOnDialAnswer` + `redirect="false"`.
//     Drop `redirect="false"` and the call follows the Record action instead of dialling.
//   • The callee whisper is `confirmSound` on `<Dial>`, not a url on `<Number>`.
//   • `<Speak>`, not `<Say>`.
//   • The create-call response gives a `request_uuid`, NOT the call id. The real `CallUUID`
//     arrives later on the callbacks, which is what gets stored as `Call.providerSid`.
//   • Signature validation signs a REBUILT url with sorted query params, not the url as sent.
//
// Fail-safe, like the Twilio provider: helpers log and return a result; they never throw
// into the calling flow.
import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { dialablePhone } from "@/lib/phone";
import { logger } from "@/lib/logger";
import { callbackQuery, patientRingSeconds } from "@/lib/clickToCallLog";

const API = "https://api.plivo.com/v1/Account";

export function isPlivoConfigured(): boolean {
  return (
    !!process.env.PLIVO_AUTH_ID &&
    !!process.env.PLIVO_AUTH_TOKEN &&
    !!process.env.PLIVO_CALLER_ID
  );
}

/// Public base URL Plivo should call back on. Shared with the Twilio provider on purpose —
/// it is a property of OUR deployment, not of the telephony vendor.
export function publicBase(): string {
  return (process.env.TWILIO_PUBLIC_BASE ?? process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
}

// ── Two caller IDs, same reasoning as Twilio ─────────────────────────────────
// Unlike Twilio there is no "verify a number you own" route: on India domestic routes the
// caller ID MUST be a number rented from Plivo. That removes the From == To trap that made
// the Twilio version so fiddly — a rented number is never a counsellor's handset — but the
// rep leg is kept separately configurable anyway, because the day somebody points
// PLIVO_CALLER_ID at something clever is the day it matters.

/// What the PATIENT sees. A Plivo-rented Indian number (022 landline for us).
export function plivoPatientCallerId(): string {
  return process.env.PLIVO_CALLER_ID ?? "";
}

/// The number used to ring the COUNSELLOR. Falls back to the patient caller ID.
export function plivoRepCallerId(avoid?: string): string {
  const configured = process.env.PLIVO_REP_CALLER_ID?.trim() || plivoPatientCallerId();
  if (!avoid) return configured;
  const same = (a: string, b: string) =>
    a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);
  if (!same(configured, avoid)) return configured;
  logger.error(
    `Plivo: caller ID ${configured} is this counsellor's own number — Plivo will reject From == To. ` +
      `Set PLIVO_REP_CALLER_ID to a different number you rent.`,
  );
  return configured;
}

export type PlivoCallResult = { ok: true; requestUuid: string } | { ok: false; error: string };

/// Start a recorded click-to-call: ring `repPhone`; on answer Plivo fetches our XML (which
/// dials the lead, records and bridges). `repId` is threaded through the callback URLs so
/// the recording is attributed to whoever pressed the button.
///
/// Returns the REQUEST uuid, which is not the call id — Plivo assigns `CallUUID` when the
/// leg actually goes up, and that arrives on the callbacks.
///
/// `callId` is our Call row (created before this rings, see lib/providers/calling.ts). It
/// rides on every callback url so each one updates that row.
///
/// `hangup_url` is set explicitly. Left unset, Plivo sends the hang-up of the counsellor's
/// leg to `answer_url`, which answered it with dial XML that nobody would ever play — so a
/// counsellor who didn't pick up their own phone left no trace anywhere.
export async function plivoClickToCall(
  repPhone: string,
  leadId: string,
  repId?: string,
  callId?: string,
): Promise<PlivoCallResult> {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  const from = plivoRepCallerId(repPhone);
  if (!id || !token || !from) return { ok: false, error: "Plivo not configured" };
  const base = publicBase();
  if (!base) return { ok: false, error: "No public base URL (set TWILIO_PUBLIC_BASE or NEXTAUTH_URL)" };

  const repDialable = dialablePhone(repPhone) ?? repPhone;
  try {
    const qs = callbackQuery({ repId, callId });
    const answerUrl = `${base}/api/plivo/voice/${leadId}${qs ? `?${qs}` : ""}`;
    const hangupUrl = `${base}/api/plivo/hangup?${callbackQuery({ leadId, repId, callId })}`;
    const res = await axios.post(
      `${API}/${id}/Call/`,
      {
        from: from.replace(/^\+/, ""), // Plivo takes bare digits on the REST API
        to: repDialable.replace(/^\+/, ""),
        answer_url: answerUrl,
        answer_method: "POST",
        hangup_url: hangupUrl,
        hangup_method: "POST",
      },
      {
        auth: { username: id, password: token },
        headers: { "Content-Type": "application/json" },
        timeout: 15_000,
      },
    );
    return { ok: true, requestUuid: res.data?.request_uuid ?? "" };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    logger.error(`Plivo click-to-call failed (lead ${leadId}): ${detail}`);
    return { ok: false, error: detail };
  }
}

/// Escape a value for safe embedding in XML. Same reasoning as the Twilio provider: the
/// callback URLs carry `leadId=…&repId=…`, and a raw `&` makes the document invalid — which
/// Plivo answers by playing an error to the counsellor instead of dialling the patient.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/// XML returned when the counsellor answers: announce, start a background recording of the
/// whole session, then dial the patient.
///
/// The `<Record>` sits BEFORE the `<Dial>` and carries three attributes that have to be
/// right together:
///   recordSession="true"      — capture both legs, not just the counsellor
///   startOnDialAnswer="true"  — begin when the PATIENT picks up, so the ringing isn't in it
///   redirect="false"          — do not follow the Record action; fall through to the Dial
/// Without `redirect="false"` the call never reaches the patient at all.
///
/// Recording-consent disclosure (§compliance C1): `<Speak>` here is heard only by the
/// counsellor, so the patient's disclosure rides on `confirmSound`, which Plivo fetches and
/// plays TO THE CALLEE when they answer, before the legs bridge.
///
/// On the `<Dial>`:
///   timeout     — how long the patient's phone rings (CLICK_TO_CALL_RING_SECONDS).
///   dialMusic="real" — the counsellor hears the patient's ACTUAL network audio while it
///                 rings, not Plivo's synthetic ringtone. Indian carriers rarely send a
///                 clean "rejected": they play "the number you are calling is busy" over
///                 early media and keep the leg up. The synthetic tone hid that, so a
///                 patient who declined after three rings sounded like ten more rings.
export function dialLeadPlivoXML(
  leadPhone: string,
  leadId: string,
  repId?: string,
  callId?: string,
): string {
  const base = publicBase();
  const qs = callbackQuery({ leadId, repId, callId });
  const recordingCb = `${base}/api/webhooks/plivo/recording?${qs}`;
  const action = `${base}/api/plivo/dial-result?${qs}`;
  const whisper = `${base}/api/plivo/whisper`;
  const from = plivoPatientCallerId();
  const dialable = dialablePhone(leadPhone) ?? leadPhone;
  // Plivo caps a single recording at maxLength seconds; the default of 60 would truncate
  // every real consultation to a minute.
  const maxLength = Number(process.env.PLIVO_MAX_RECORDING_SECONDS ?? 3600);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Speak>Connecting you to the patient now. This call is recorded.</Speak>` +
    `<Record recordSession="true" startOnDialAnswer="true" redirect="false" ` +
    `fileFormat="mp3" maxLength="${maxLength}" recordChannelType="stereo" ` +
    `callbackUrl="${xmlEscape(recordingCb)}" callbackMethod="POST"/>` +
    `<Dial callerId="${xmlEscape(from)}" action="${xmlEscape(action)}" method="POST" ` +
    `timeout="${patientRingSeconds()}" dialMusic="real" ` +
    `confirmSound="${xmlEscape(whisper)}">` +
    `<Number>${xmlEscape(dialable)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/// Spoken to the counsellor when the patient leg didn't connect. Mirrors the Twilio version
/// deliberately, including its refusal to blame the lead's number: a failed leg is just as
/// likely to be the caller ID, and then it fails for every patient at once.
export function dialFailedPlivoXML(status: string): string {
  const reason =
    status === "busy"
      ? "The patient's number is busy."
      : status === "no-answer" || status === "timeout"
        ? "The patient did not answer."
        : status === "failed"
          ? "The call could not be placed. If this is happening on every call, it is the " +
            "clinic's caller ID setting, not this number — please tell an admin."
          : status === "completed" || status === "answered"
            ? null
            : "The call has ended.";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>${reason ? `<Speak>${xmlEscape(reason)}</Speak>` : ""}<Hangup/></Response>`
  );
}

/// The recording-disclosure whisper played to the PATIENT via `confirmSound` when they
/// answer, before the legs bridge (§compliance C1).
export function recordingWhisperPlivoXML(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Speak>This call is recorded for quality and training purposes.</Speak>` +
    `</Response>`
  );
}

// ── Inbound: a patient rings the clinic line (§presence) ─────────────────────
// The ladder is the Twilio one, rebuilt in Plivo XML: every <Dial> carries an `action`
// back to /api/plivo/inbound, which fires when that leg ends and decides the next hop.
// WHO rings is decided in lib/inboundRouting.ts, not here.

const INBOUND_GREETING =
  process.env.CLINIC_CALL_GREETING ??
  "Thank you for calling Cara Clinic. Please hold while we connect you to your counsellor. " +
    "This call may be recorded for quality and training purposes.";

/// Ring one counsellor for the caller. The greeting (with the recording disclosure, §C1) is
/// spoken on the first hop only — a caller walking the ladder shouldn't hear it again
/// between attempts.
///
/// `confirmSound` is fetched only when the COUNSELLOR answers and is played to them alone,
/// which makes it both the whisper ("your patient Priya is calling") and the earliest
/// reliable "they picked up" signal. The `<Record>` before the `<Dial>` is the same
/// three-attribute recipe as the outbound call — see dialLeadPlivoXML.
///
/// On an Indian route the caller ID on the counsellor's leg must be a number we rent from
/// Plivo, so their handset shows the clinic line, not the patient — which is why the
/// whisper names the caller.
export function inboundDialRepPlivoXML(opts: {
  repPhone: string;
  /// The clinic number the patient dialled — a number we rent from Plivo, so always a valid
  /// caller ID. Used when PLIVO_REP_CALLER_ID / PLIVO_CALLER_ID aren't set.
  clinicNumber?: string;
  whisperUrl: string;
  actionUrl: string;
  recordingCallbackUrl: string;
  timeoutSec: number;
  greet: boolean;
}): string {
  const maxLength = Number(process.env.PLIVO_MAX_RECORDING_SECONDS ?? 3600);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    (opts.greet ? `<Speak>${xmlEscape(INBOUND_GREETING)}</Speak>` : "") +
    `<Record recordSession="true" startOnDialAnswer="true" redirect="false" ` +
    `fileFormat="mp3" maxLength="${maxLength}" recordChannelType="stereo" ` +
    `callbackUrl="${xmlEscape(opts.recordingCallbackUrl)}" callbackMethod="POST"/>` +
    `<Dial callerId="${xmlEscape(plivoRepCallerId(opts.repPhone) || opts.clinicNumber || "")}" ` +
    `action="${xmlEscape(opts.actionUrl)}" method="POST" timeout="${opts.timeoutSec}" ` +
    `confirmSound="${xmlEscape(opts.whisperUrl)}" confirmSoundMethod="POST">` +
    `<Number>${xmlEscape(opts.repPhone)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/// Played to the COUNSELLOR when they pick up an inbound call, before the caller is bridged.
/// `newCaller`: a first-time caller who has just become this counsellor's lead.
export function inboundWhisperPlivoXML(patientName: string | null, sticky: boolean, newCaller = false): string {
  const text = newCaller
    ? "A new patient is calling the clinic. They are now your lead. Connecting now."
    : patientName
      ? `${sticky ? "Your patient" : "Patient"} ${patientName} is calling the clinic. Connecting now.`
      : "A patient is calling the clinic. Connecting now.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>${xmlEscape(text)}</Speak></Response>`;
}

/// Nobody free on the first pass: hold briefly, then run the whole ladder once more.
/// `greet` on the first hop — otherwise a caller nobody could take never hears the welcome
/// or the recording disclosure (§C1) before being asked to leave a message.
export function inboundHoldPlivoXML(retryUrl: string, holdSec: number, greet = false): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    (greet ? `<Speak>${xmlEscape(INBOUND_GREETING)}</Speak>` : "") +
    `<Speak>All our counsellors are with patients right now. Please hold for a moment.</Speak>` +
    `<Wait length="${holdSec}"/>` +
    `<Redirect method="POST">${xmlEscape(retryUrl)}</Redirect>` +
    `</Response>`
  );
}

/// Last resort — take a message. `actionUrl` fires when the message ends, files it on the
/// call and answers with the goodbye (Plivo follows the action, so nothing after <Record>
/// would play). `callbackUrl` fires once the audio is actually downloadable, which is when
/// it can be transcribed.
export function inboundVoicemailPlivoXML(actionUrl: string, callbackUrl: string, maxSec = 120): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Speak>We are sorry to keep you waiting. Please leave your name and message after the tone, ` +
    `and a counsellor will call you back.</Speak>` +
    `<Record action="${xmlEscape(actionUrl)}" method="POST" maxLength="${maxSec}" ` +
    `playBeep="true" timeout="5" finishOnKey="#" fileFormat="mp3" ` +
    `callbackUrl="${xmlEscape(callbackUrl)}" callbackMethod="POST"/>` +
    `</Response>`
  );
}

/// End the call, optionally saying something first.
export function hangupPlivoXML(say?: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>${say ? `<Speak>${xmlEscape(say)}</Speak>` : ""}<Hangup/></Response>`
  );
}

// ── Signature validation (V3) ────────────────────────────────────────────────
// Ported from Plivo's own node SDK (`utils/v3Security.js`) rather than from the prose docs,
// which are ambiguous about one detail that decides every outcome: whether a separator sits
// between the url and the POST params. It does — but ONLY when there are POST params AND the
// url has a query string. Getting it wrong fails closed, which looks exactly like "Plivo
// stopped calling us".
//
// The signed string is a REBUILT url (query params re-sorted into `k=v&…`), not the url as
// received, so the request url cannot simply be concatenated.

/// Rebuild the url the way Plivo signs it. `withTrailingDot` is the SDK's
/// `!empty_post_params`: true when POST params exist.
function plivoSignedUrl(uri: string, extra: Record<string, string>, withTrailingDot: boolean): string {
  const u = new URL(uri);
  const params = new Map<string, string[]>();
  for (const [k, v] of u.searchParams.entries()) {
    params.set(k, [...(params.get(k) ?? []), v]);
  }
  for (const [k, v] of Object.entries(extra)) {
    params.set(k, [...(params.get(k) ?? []), v]);
  }
  const query = [...params.keys()]
    .sort()
    .flatMap((k) => [...(params.get(k) ?? [])].sort().map((v) => `${k}=${v}`))
    .join("&");

  let base = `${u.protocol}//${u.host}${u.pathname}`;
  if (query.length > 0 || withTrailingDot) base += `?${query}`;
  if (query.length > 0 && withTrailingDot) base += ".";
  return base;
}

/// `k`+`v` for every POST param, keys sorted, concatenated with no separator at all.
function plivoSortedParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
}

/// Verify `X-Plivo-Signature-V3` over the exact public URL Plivo called plus its POST params.
/// Plivo may send several comma-separated signatures when more than one auth token is live;
/// a match against any one is a pass.
export function plivoSignatureFor(
  url: string,
  params: Record<string, string>,
  nonce: string,
  token: string,
  method: "POST" | "GET" = "POST",
): string {
  let base: string;
  if (method === "GET") {
    base = plivoSignedUrl(url, params, false);
  } else {
    const hasParams = Object.keys(params).length > 0;
    base = plivoSignedUrl(url, {}, hasParams) + plivoSortedParams(params);
  }
  return createHmac("sha256", token).update(`${base}.${nonce}`).digest("base64");
}

export function verifyPlivoSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
  nonce: string | null,
  method: "POST" | "GET" = "POST",
): boolean {
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!token || !signature || !nonce) return false;
  const expected = plivoSignatureFor(url, params, nonce, token, method);

  // Compare against each candidate in constant time; `some` is fine because the lengths are
  // checked first and a mismatched length is not secret.
  return signature.split(",").some((candidate) => {
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate.trim());
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/// Read a Plivo webhook's form params and verify its signature over the exact public URL it
/// called. `params` is null when the signature fails.
export async function readSignedPlivoRequest(
  req: Request,
): Promise<{ url: URL; params: Record<string, string> | null }> {
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("form")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  }
  const ok = verifyPlivoSignature(
    `${publicBase()}${url.pathname}${url.search}`,
    params,
    req.headers.get("x-plivo-signature-v3"),
    req.headers.get("x-plivo-signature-v3-nonce"),
  );
  return { url, params: ok ? params : null };
}

/// The recording Plivo made on this call, if any — looked up by call id rather than waited
/// for. Used to collect a voicemail whose callbacks never reached us (a caller hanging up
/// mid-message can skip the <Record> action). Returns the longest recording on the call.
export async function findPlivoRecordingForCall(
  callUuid: string,
): Promise<{ url: string; durationSec: number } | null> {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token || !callUuid) return null;
  try {
    const res = await axios.get(`${API}/${id}/Recording/`, {
      params: { call_uuid: callUuid },
      auth: { username: id, password: token },
      timeout: 15_000,
    });
    const recs = (res.data?.objects ?? []) as { recording_url?: string; recording_duration_ms?: string }[];
    const best = recs
      .map((r) => ({ url: r.recording_url ?? "", ms: parseFloat(r.recording_duration_ms ?? "0") }))
      .filter((r) => r.url)
      .sort((a, b) => b.ms - a.ms)[0];
    return best ? { url: best.url, durationSec: Math.round(best.ms / 1000) } : null;
  } catch (err) {
    logger.error(`Plivo recording lookup failed for call ${callUuid}: ${String(err)}`);
    return null;
  }
}

/// Delete a recording's audio at Plivo (§compliance C3 — erasure / retention). The recording
/// id is parsed out of the stored URL. Best-effort: true on success or if already gone.
///
/// NOTE: Plivo deletes recordings on its own after 30 days, so an erasure request for an
/// older call will find nothing here — which is a pass, not a failure, but it also means the
/// in-CRM audio player cannot reach anything older than that. See the retention note in
/// docs/indian-telephony-migration.md.
export async function deletePlivoRecording(recordingUrl: string): Promise<boolean> {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) return false;
  const match = recordingUrl.match(/([0-9a-fA-F-]{36})/);
  if (!match) {
    logger.warn(`Plivo recording delete: no recording id in URL ${recordingUrl}`);
    return false;
  }
  try {
    await axios.delete(`${API}/${id}/Recording/${match[1]}/`, {
      auth: { username: id, password: token },
      timeout: 15_000,
    });
    return true;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return true; // already gone
    logger.error(`Plivo recording delete failed (${match[1]}): ${String(err)}`);
    return false;
  }
}

/// Fetch a recording's audio for transcription and the in-CRM player.
export async function fetchPlivoRecording(
  recordingUrl: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) return null;
  try {
    const res = await axios.get<ArrayBuffer>(recordingUrl, {
      auth: { username: id, password: token },
      responseType: "arraybuffer",
      timeout: 20_000,
    });
    return { buffer: Buffer.from(res.data), mime: "audio/mpeg" };
  } catch (err) {
    logger.error(`Plivo recording fetch failed: ${String(err)}`);
    return null;
  }
}
