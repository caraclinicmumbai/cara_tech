// Inbound Voice webhook for the published clinic number (§presence).
//
// Point the Twilio number's "A CALL COMES IN" Voice URL at this route (POST). It
// answers every call and walks one ladder:
//
//   owner rings (sticky)  ->  same-speciality colleague  ->  round-robin
//        -> brief hold, then one more pass -> voicemail
//
// Twilio drives the ladder itself: each <Dial> carries an `action` back here, which
// fires when that leg ends for ANY reason (no answer, busy, or a real conversation).
// A completed conversation ends the call; anything else advances to the next rep,
// with the reps already rung carried in `tried` so nobody's silent handset rings twice.
//
// WHO to ring is decided in lib/inboundRouting.ts — this file is the Twilio adapter
// and holds no policy of its own.
import { NextResponse } from "next/server";
import { routeInboundCall } from "@/lib/inboundRouting";
import {
  inboundCallerId,
  inboundDialRepTwiML,
  inboundHoldTwiML,
  inboundVoicemailTwiML,
  verifyTwilioSignature,
  publicBase,
} from "@/lib/providers/twilio";
import { logger } from "@/lib/logger";

/// How long one counsellor's phone rings before we move down the ladder.
const RING_SECONDS = Number(process.env.INBOUND_RING_SECONDS ?? 20);
/// How long the caller holds before the second pass.
const HOLD_SECONDS = Number(process.env.INBOUND_HOLD_SECONDS ?? 25);

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml" } });

/// A spoken dead-end. Used when we can't identify the caller at all.
const sayAndHangup = (msg: string) =>
  xml(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${msg}</Say><Hangup/></Response>`,
  );

export async function POST(req: Request) {
  const url = new URL(req.url);

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  // Twilio signs the exact public URL it called, query string included.
  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  if (!verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"))) {
    logger.warn("Twilio inbound webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const from = params.From ?? "";
  const to = params.To ?? null;
  const callSid = params.CallSid ?? "";
  // Set on the continuation hop: how the previous rep's leg ended.
  const dialStatus = params.DialCallStatus ?? null;
  // Repeated `tried=<id>` params rather than one comma-joined value. Signature
  // verification compares the URL Twilio signed against the one we rebuild from
  // `req.url`, and Next re-encodes some characters on the way in (a raw "," arrives
  // as "%2C") — which silently 403s the whole ladder. Bare cuids need no encoding at
  // all, so both sides always agree.
  const tried = url.searchParams.getAll("tried").filter(Boolean);
  const held = url.searchParams.get("held") === "1";

  if (!from) return sayAndHangup("Sorry, we could not identify your number. Please call again.");

  // The caller actually spoke to someone — that leg completing IS the call.
  if (dialStatus === "completed") {
    return xml(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  const base = publicBase();
  const route = await routeInboundCall(from, { exclude: tried });

  if (route.kind === "connect") {
    const q = new URLSearchParams();
    for (const id of [...tried, route.rep.id]) q.append("tried", id);
    if (held) q.set("held", "1");

    logger.info(
      `Inbound ${from} (call ${callSid}) -> ${route.rep.name} [${route.sticky ? "sticky" : "cover"}] - ${route.reason}`,
    );

    const whisper = new URLSearchParams({
      repId: route.rep.id,
      leadId: route.lead.id,
      name: route.lead.name,
      sticky: route.sticky ? "1" : "0",
    });
    const recording = new URLSearchParams({
      leadId: route.lead.id,
      repId: route.rep.id,
      inbound: "1",
    });

    return xml(
      inboundDialRepTwiML({
        repPhone: route.rep.phone,
        callerId: inboundCallerId(to),
        whisperUrl: `${base}/api/twilio/inbound/whisper?${whisper}`,
        actionUrl: `${base}/api/twilio/inbound?${q}`,
        recordingCallbackUrl: `${base}/api/webhooks/twilio/recording?${recording}`,
        timeoutSec: RING_SECONDS,
        // Greet once, on the first hop only — a caller walking the ladder shouldn't
        // hear the whole welcome message again between each attempt.
        greet: tried.length === 0 && !held,
      }),
    );
  }

  // Nobody free. Hold once and try the whole ladder again — a counsellor hanging up
  // in the next half-minute takes this call instead of it going to voicemail.
  if (!held) {
    logger.info(`Inbound ${from} (call ${callSid}) - nobody free, holding: ${route.reason}`);
    return xml(
      inboundHoldTwiML(`${base}/api/twilio/inbound?held=1`, HOLD_SECONDS),
    );
  }

  logger.info(`Inbound ${from} (call ${callSid}) -> voicemail: ${route.reason}`);
  // leadId alone — the voicemail handler looks the caller up from it, and every extra
  // parameter is another chance for an encoding mismatch to break the signature.
  const vm = new URLSearchParams({ leadId: route.lead.id });
  return xml(inboundVoicemailTwiML(`${base}/api/twilio/inbound/voicemail?${vm}`));
}
