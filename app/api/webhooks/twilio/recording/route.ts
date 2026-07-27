// Twilio recording webhook (§3.1). Fired when a handover call's recording is
// ready. Verifies the Twilio signature, then stores the recording as a Call on
// the lead so it shows up in the CRM.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyTwilioSignature, publicBase } from "@/lib/providers/twilio";
import { transcribeAndScoreCall } from "@/lib/callTranscription";
import { endConsultation } from "@/lib/presence";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const leadId = url.searchParams.get("leadId");

  const repId = url.searchParams.get("repId") ?? undefined;

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  // Reconstruct the exact public URL Twilio signed (base + path + the same query
  // string it was configured with, including repId).
  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  if (!verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"))) {
    logger.warn("Twilio recording webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  // Twilio gives a base URL; append .mp3 for a playable file.
  const recordingUrl = params.RecordingUrl ? `${params.RecordingUrl}.mp3` : undefined;
  const duration = params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : undefined;

  // Idempotency: Twilio retries recording callbacks. Skip if we've already stored
  // this CallSid (the unique providerSid would otherwise reject the duplicate, and
  // we must not re-run transcription/scoring).
  if (params.CallSid) {
    const existing = await prisma.call.findUnique({ where: { providerSid: params.CallSid } });
    if (existing) {
      logger.info(`Duplicate Twilio recording callback for ${params.CallSid} — already stored (call ${existing.id})`);
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }
  }

  const call = await prisma.call.create({
    data: {
      leadId,
      callType: "human_handover",
      recordingUrl,
      duration: Number.isFinite(duration) ? duration : undefined,
      providerSid: params.CallSid,
      handledById: repId, // the rep who initiated the click-to-call
    },
  });
  logger.info(`Stored human-handover recording for lead ${leadId} (call ${call.id}, ${duration ?? "?"}s)`);

  // §presence auto-detect: the click-to-call has ended → revert the rep from
  // In-Consultation back to Active (only if we auto-set it). Best-effort.
  if (repId) void endConsultation(repId);

  // Transcribe (ElevenLabs Scribe) + CQS-score in the background so this webhook
  // returns within Twilio's callback timeout — a long call's transcript+score can
  // take 30–90s. The persistent Node server keeps the promise alive.
  if (recordingUrl) {
    void transcribeAndScoreCall(call.id, recordingUrl);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
