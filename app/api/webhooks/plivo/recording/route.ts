// Plivo recording webhook (§3.1). Fires when a handover call's recording is ready. Verifies
// the V3 signature, then stores the recording as a Call on the lead so it shows in the CRM.
//
// Mirrors the Twilio webhook, with three differences that are Plivo's, not ours:
//   • the audio url arrives ready to play as `RecordUrl` — no `.mp3` to append;
//   • the correlation id is `CallUUID`, and duration comes as `RecordingDuration` seconds;
//   • the row is stamped `provider: "plivo"`, which is what lets the audio be fetched or
//     ERASED later. Without it a DPDP erasure would be dispatched at Twilio and fail quietly.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPlivoSignature, publicBase } from "@/lib/providers/plivo";
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

  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  if (
    !verifyPlivoSignature(
      signedUrl,
      params,
      req.headers.get("x-plivo-signature-v3"),
      req.headers.get("x-plivo-signature-v3-nonce"),
    )
  ) {
    logger.warn("Plivo recording webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const recordingUrl = params.RecordUrl || undefined;
  const rawDuration = params.RecordingDuration ?? params.RecordingDurationMs;
  const duration = params.RecordingDuration
    ? parseInt(params.RecordingDuration, 10)
    : params.RecordingDurationMs
      ? Math.round(parseInt(params.RecordingDurationMs, 10) / 1000)
      : undefined;
  void rawDuration;

  // Idempotency: Plivo retries callbacks. The unique providerSid would reject a duplicate
  // anyway, but transcription and CQS scoring must not run twice.
  const sid = params.CallUUID;
  if (sid) {
    const existing = await prisma.call.findUnique({ where: { providerSid: sid } });
    if (existing) {
      logger.info(`Duplicate Plivo recording callback for ${sid} — already stored (call ${existing.id})`);
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }
  }

  const isInbound = url.searchParams.get("inbound") === "1";

  const call = await prisma.call.create({
    data: {
      leadId,
      callType: isInbound ? "inbound" : "human_handover",
      provider: "plivo",
      recordingUrl,
      duration: Number.isFinite(duration) ? duration : undefined,
      providerSid: sid || undefined,
      handledById: repId,
      // The patient heard the disclosure via `confirmSound` before the legs bridged (§C1).
      recordingConsent: true,
    },
  });
  logger.info(`Stored Plivo handover recording for lead ${leadId} (call ${call.id}, ${duration ?? "?"}s)`);

  // §presence auto-detect: the click-to-call has ended → revert the rep from
  // In-Consultation back to Active (only if we auto-set it). Best-effort.
  if (repId) void endConsultation(repId);

  // Transcribe + CQS-score in the background so this webhook returns inside Plivo's callback
  // timeout; a long call can take 30–90s.
  if (recordingUrl) void transcribeAndScoreCall(call.id, recordingUrl);

  return NextResponse.json({ ok: true }, { status: 200 });
}
