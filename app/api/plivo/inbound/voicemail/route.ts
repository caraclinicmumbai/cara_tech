// A patient rang the clinic line, nobody was free, and they left a message.
//
// Plivo calls this twice for one message, for different reasons:
//   • the <Record> `action`, when the message ends — files it on the call as "IVR Missed"
//     with the recording, and answers with the goodbye the caller hears;
//   • the `callbackUrl` (`ready=1`), once the audio is actually downloadable — which is
//     when it can be transcribed, so nobody has to listen to it to triage it.
// Either may arrive first, or alone (a caller hanging up mid-message can skip the action),
// so both file the message; marking the call missed is idempotent (lib/inboundCallLog.ts).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readSignedPlivoRequest, hangupPlivoXML } from "@/lib/providers/plivo";
import { markInboundMissed, MIN_VOICEMAIL_SECONDS } from "@/lib/inboundCallLog";
import { transcribeAndScoreCall } from "@/lib/callTranscription";
import { logger } from "@/lib/logger";

const goodbye = () =>
  new NextResponse(hangupPlivoXML("Thank you. We will call you back shortly. Goodbye."), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });

export async function POST(req: Request) {
  const { url, params } = await readSignedPlivoRequest(req);
  if (!params) {
    logger.warn("Plivo inbound voicemail webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  const ready = url.searchParams.get("ready") === "1";
  const done = () => (ready ? NextResponse.json({ ok: true }, { status: 200 }) : goodbye());

  const callId = url.searchParams.get("callId");
  const call = callId
    ? await prisma.call.findUnique({ where: { id: callId }, select: { id: true, callType: true } })
    : null;
  if (!call || call.callType !== "inbound") {
    logger.warn(`Plivo inbound voicemail for unknown call ${callId ?? "(none)"} — message not filed`);
    return done();
  }

  const recordingUrl = params.RecordUrl || undefined;
  const duration = params.RecordingDuration
    ? parseInt(params.RecordingDuration, 10)
    : params.RecordingDurationMs
      ? Math.round(parseInt(params.RecordingDurationMs, 10) / 1000)
      : undefined;

  // A fraction of a second is a caller hanging up at the tone — a missed call, not a message.
  if (duration != null && Number.isFinite(duration) && duration < MIN_VOICEMAIL_SECONDS) {
    await markInboundMissed(call.id, { reason: "They hung up at the voicemail tone." });
    return done();
  }
  await markInboundMissed(call.id, {
    voicemail: { recordingUrl, duration },
    reason: "Nobody was free — they left a voicemail.",
  });

  if (ready && recordingUrl) {
    // Plivo retries callbacks; transcribe only while nothing has been written yet.
    const fresh = await prisma.call.findUnique({ where: { id: call.id }, select: { transcript: true } });
    if (!fresh?.transcript) void transcribeAndScoreCall(call.id, recordingUrl);
  }

  return done();
}
