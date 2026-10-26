// The caller's side of an inbound call has ended — the Hangup URL of the Plivo Application
// on the clinic number. It fires however the call went, which makes it the one place that
// catches the call nobody answered and nobody left a message on: the caller gave up while
// the ladder was still ringing counsellors, or hung up at the voicemail prompt.
//
// A row still "ringing" here was never picked up — it becomes "IVR Missed" and the owner
// gets the callback (lib/inboundCallLog.ts). A connected call is left as it is; this only
// releases the counsellor from their automatic In-Consultation.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readSignedPlivoRequest } from "@/lib/providers/plivo";
import { markInboundMissed } from "@/lib/inboundCallLog";
import { endConsultation } from "@/lib/presence";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const { params } = await readSignedPlivoRequest(req);
  if (!params) {
    logger.warn("Plivo inbound hangup webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const callUuid = params.CallUUID ?? "";
  const call = callUuid
    ? await prisma.call.findUnique({
        where: { providerSid: callUuid },
        select: { id: true, callType: true, outcome: true, handledById: true },
      })
    : null;
  if (!call || call.callType !== "inbound") {
    // Hung up before the answer webhook logged anything (or not a call we know).
    logger.info(`Plivo inbound hangup for unknown call ${callUuid || "(no uuid)"} — nothing to settle`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  if (call.outcome === "ringing") {
    await markInboundMissed(call.id, { reason: "They hung up before anyone answered." });
  }
  if (call.handledById) void endConsultation(call.handledById);

  return NextResponse.json({ ok: true }, { status: 200 });
}
