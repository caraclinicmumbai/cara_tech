// Played to the COUNSELLOR the moment they pick up an inbound patient call, before the
// caller is bridged (`confirmSound` on the <Dial> in /api/plivo/inbound). Three jobs:
//   1. Tell them who is on the line — and whether it's their own patient calling back.
//   2. Mark the call connected and handled by them, so the log says "IVR Incoming" with
//      the right name even if a later callback is lost.
//   3. Flip them to In-Consultation (§presence), so the next inbound call routes to
//      somebody else instead of ringing a handset that is already in use.
//
// Plivo fetches this only when the counsellor's leg answers — the earliest reliable "they
// picked up" signal. A failed signature still gets a generic whisper rather than a 403: the
// counsellor has already answered, and an error here would play them an error instead of
// connecting the patient. It just doesn't change anything.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readSignedPlivoRequest, inboundWhisperPlivoXML } from "@/lib/providers/plivo";
import { markInboundConnected } from "@/lib/inboundCallLog";
import { beginConsultation } from "@/lib/presence";
import { logger } from "@/lib/logger";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml" } });

export async function POST(req: Request) {
  const { url, params } = await readSignedPlivoRequest(req);
  if (!params) {
    logger.warn("Plivo inbound whisper: bad signature — generic whisper, no state change");
    return xml(inboundWhisperPlivoXML(null, false));
  }

  const callId = url.searchParams.get("callId");
  const repId = url.searchParams.get("repId");
  const sticky = url.searchParams.get("sticky") === "1";

  const call = callId
    ? await prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, callType: true, lead: { select: { name: true } } },
      })
    : null;

  // Best-effort: bookkeeping must never stop the call connecting.
  if (call?.callType === "inbound") await markInboundConnected(call.id, { repId: repId ?? undefined });
  if (repId) void beginConsultation(repId);

  return xml(inboundWhisperPlivoXML(call?.lead.name ?? null, sticky));
}
