// A patient rang the clinic, nobody was free, and they left a message.
//
// A voicemail nobody is accountable for is a lost patient, so this does three things:
//   1. stores the recording as an inbound Call on the lead (transcribed + scored like
//      any other call, so the counsellor can read it rather than listen);
//   2. puts a "Return missed call" step at the top of the owner's roadmap, due now;
//   3. pings the counsellor channel on Slack.
//
// Twilio hits this URL twice for one message — once as the <Record> `action` and once
// as the `recordingStatusCallback` — so it is idempotent on CallSid.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyTwilioSignature, publicBase } from "@/lib/providers/twilio";
import { transcribeAndScoreCall } from "@/lib/callTranscription";
import { notifyCounsellor } from "@/lib/counsellor";
import { logger } from "@/lib/logger";

const xml = (body: string) =>
  new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml" } });

/// Twilio expects TwiML back from the <Record> action; an empty Response just ends
/// the call cleanly after the closing message has played.
const done = () => xml(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);

export async function POST(req: Request) {
  const url = new URL(req.url);
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  if (!verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"))) {
    logger.warn("Twilio voicemail webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const leadId = url.searchParams.get("leadId");
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, name: true, phone: true, assignedRepId: true, assignedRep: { select: { name: true } } },
  });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const callSid = params.CallSid ?? "";
  // Both callbacks carry the same CallSid — first one wins.
  if (callSid) {
    const existing = await prisma.call.findUnique({ where: { providerSid: callSid } });
    if (existing) return done();
  }

  const recordingUrl = params.RecordingUrl ? `${params.RecordingUrl}.mp3` : undefined;
  const duration = params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : undefined;

  const call = await prisma.call.create({
    data: {
      leadId,
      callType: "inbound_voicemail",
      outcome: "voicemail",
      recordingUrl,
      duration: Number.isFinite(duration) ? duration : undefined,
      providerSid: callSid || undefined,
      // The greeting told the caller the line is recorded before they left a message.
      recordingConsent: true,
    },
  });

  // The owner's roadmap gets the callback, at the top and due now. If the lead has no
  // owner the step still exists (unowned), so it shows on the lead either way.
  const max = await prisma.leadFollowUpStep.aggregate({
    where: { leadId },
    _max: { order: true },
  });
  await prisma.leadFollowUpStep.create({
    data: {
      leadId,
      order: (max._max.order ?? -1) + 1,
      title: "Return missed call",
      channel: "call",
      status: "pending",
      dueAt: new Date(),
      ownerKind: "rep",
      ownerRepId: lead.assignedRepId,
      source: "auto",
      note: "Patient called the clinic line; nobody was free and they left a voicemail.",
    },
  });

  logger.info(`Inbound voicemail from ${lead.phone} stored on lead ${leadId} (call ${call.id})`);

  void notifyCounsellor({
    kind: "missed_inbound",
    lead: { id: lead.id, name: lead.name, phone: lead.phone },
    reason: "Called the clinic line - nobody was available, voicemail left",
    extra: [
      lead.assignedRep?.name ? `Owner: ${lead.assignedRep.name}` : "No owner assigned",
      duration ? `Message length: ${duration}s` : "",
    ].filter(Boolean),
  });

  // Read the message back as text so nobody has to listen to it first.
  if (recordingUrl) void transcribeAndScoreCall(call.id, recordingUrl);

  return done();
}
