// Inbound calls to the clinic line on Plivo (§presence) — the Plivo adapter for the same
// ladder the Twilio number runs (app/api/twilio/inbound):
//
//   the lead's owner rings (sticky)  ->  same-speciality colleague  ->  round-robin
//        -> brief hold, then one more pass -> voicemail
//
// Set this route as the Answer URL (POST) of the Plivo Application attached to the clinic
// number, and /api/plivo/inbound/hangup as its Hangup URL. Each <Dial> carries an `action`
// back here, which fires when that leg ends for any reason: a completed conversation ends
// the call, anything else rings the next counsellor, with the ones already rung carried in
// `tried` so nobody's silent handset rings twice.
//
// The call is logged from the first hop (lib/inboundCallLog.ts) — "IVR Incoming" in the
// call log, settled to "IVR Missed" if nobody ever picks up.
//
// WHO to ring is decided in lib/inboundRouting.ts — this file holds no policy of its own.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { routeInboundCall } from "@/lib/inboundRouting";
import { startInboundCall, markInboundConnected } from "@/lib/inboundCallLog";
import {
  readSignedPlivoRequest,
  publicBase,
  inboundDialRepPlivoXML,
  inboundHoldPlivoXML,
  inboundVoicemailPlivoXML,
  hangupPlivoXML,
} from "@/lib/providers/plivo";
import { callbackQuery } from "@/lib/clickToCallLog";
import { endConsultation } from "@/lib/presence";
import { logger } from "@/lib/logger";

/// How long one counsellor's phone rings before we move down the ladder.
const RING_SECONDS = Number(process.env.INBOUND_RING_SECONDS ?? 20);
/// How long the caller holds before the second pass.
const HOLD_SECONDS = Number(process.env.INBOUND_HOLD_SECONDS ?? 25);

/// A-leg statuses that mean the caller is already gone — nothing left to route.
const CALLER_GONE = new Set(["completed", "busy", "failed", "no-answer", "timeout", "cancel", "canceled"]);

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml" } });

export async function POST(req: Request) {
  const { url, params } = await readSignedPlivoRequest(req);
  if (!params) {
    logger.warn("Plivo inbound webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const callUuid = params.CallUUID ?? "";
  // Only bare cuids ride on these urls: the signature is checked against a url rebuilt from
  // `req.url`, and anything Next re-encodes on the way in would fail it (see flow doc 11).
  const tried = url.searchParams.getAll("tried").filter(Boolean);
  const held = url.searchParams.get("held") === "1";
  const lastRep = url.searchParams.get("rep");

  const logged = callUuid
    ? await prisma.call.findUnique({
        where: { providerSid: callUuid },
        select: { id: true, lead: { select: { phone: true } } },
      })
    : null;
  // Continuation hops normally carry From too; the logged call is the fallback.
  const from = params.From || logged?.lead.phone || "";

  // ── Continuation hop: how did the previous counsellor's leg end? ──
  const dialStatus = params.DialBLegStatus ?? params.DialStatus ?? null;
  if (dialStatus === "completed" || dialStatus === "answered") {
    const talk = parseInt(params.DialBLegDuration ?? "", 10);
    if (logged) {
      await markInboundConnected(logged.id, {
        repId: lastRep ?? undefined,
        duration: Number.isFinite(talk) ? talk : undefined,
      });
    }
    if (lastRep) void endConsultation(lastRep);
    return xml(hangupPlivoXML());
  }
  if (dialStatus) {
    logger.info(`Plivo inbound ${from} (call ${callUuid}): counsellor ${lastRep ?? "?"} leg ended ${dialStatus}`);
  }
  // The caller hung up while a counsellor's phone rang — the hang-up callback logs the miss.
  if (params.CallStatus && CALLER_GONE.has(params.CallStatus)) return xml(hangupPlivoXML());

  if (!from) return xml(hangupPlivoXML("Sorry, we could not identify your number. Please call again."));

  const route = await routeInboundCall(from, { exclude: tried });
  const call = await startInboundCall({ leadId: route.lead.id, providerSid: callUuid, provider: "plivo" });
  if (!call) logger.warn(`Plivo inbound ${from}: no CallUUID — this call will not appear in the call log`);

  const base = publicBase();

  if (route.kind === "connect") {
    const next = new URLSearchParams();
    for (const id of [...tried, route.rep.id]) next.append("tried", id);
    next.set("rep", route.rep.id);
    if (held) next.set("held", "1");

    logger.info(
      `Plivo inbound ${from} (call ${callUuid}) -> ${route.rep.name} [${route.sticky ? "owner" : "cover"}] - ${route.reason}`,
    );

    const whisper = callbackQuery({ callId: call?.id, repId: route.rep.id });
    const recording = callbackQuery({ leadId: route.lead.id, repId: route.rep.id, callId: call?.id });

    return xml(
      inboundDialRepPlivoXML({
        repPhone: route.rep.phone,
        whisperUrl: `${base}/api/plivo/inbound/whisper?${whisper}${route.sticky ? "&sticky=1" : ""}`,
        actionUrl: `${base}/api/plivo/inbound?${next}`,
        recordingCallbackUrl: `${base}/api/webhooks/plivo/recording?${recording}&inbound=1`,
        timeoutSec: RING_SECONDS,
        greet: tried.length === 0 && !held,
      }),
    );
  }

  // Nobody free. Hold once and try the whole ladder again — a counsellor hanging up in the
  // next half-minute takes this call instead of it going to voicemail. `tried` is dropped on
  // purpose: someone who was busy a moment ago may be free now.
  if (!held) {
    logger.info(`Plivo inbound ${from} (call ${callUuid}) - nobody free, holding: ${route.reason}`);
    return xml(inboundHoldPlivoXML(`${base}/api/plivo/inbound?held=1`, HOLD_SECONDS));
  }

  logger.info(`Plivo inbound ${from} (call ${callUuid}) -> voicemail: ${route.reason}`);
  const vm = callbackQuery({ callId: call?.id });
  return xml(
    inboundVoicemailPlivoXML(
      `${base}/api/plivo/inbound/voicemail?${vm}`,
      `${base}/api/plivo/inbound/voicemail?${vm}${vm ? "&" : ""}ready=1`,
    ),
  );
}
