// How a click-to-call ENDED (§3.1). Twilio POSTs here when the `<Dial>` finishes,
// whatever the outcome — this is the only callback that fires when the patient leg
// never connects (wrong number, busy, no answer). The recording callback only fires
// on a call that actually happened, so without this a failed call left no trace at
// all: the rep heard "connecting you…", then silence, and the CRM showed nothing.
//
// A connected call is left alone here — the recording webhook owns that row, and it
// arrives with the audio. This route only records the failures, and tells the rep
// out loud why the call is ending.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyTwilioSignature, publicBase, dialFailedTwiML } from "@/lib/providers/twilio";
import { endConsultation } from "@/lib/presence";
import { notifyRep } from "@/lib/notifications";
import { logger } from "@/lib/logger";

/// Twilio's DialCallStatus values that mean "no conversation took place".
const FAILED: Record<string, string> = {
  busy: "The patient's line was busy",
  "no-answer": "The patient didn't answer",
  failed: "The carrier rejected the number",
  canceled: "The call was cancelled before it connected",
};

export async function POST(req: Request) {
  const url = new URL(req.url);
  const leadId = url.searchParams.get("leadId");
  const repId = url.searchParams.get("repId") ?? undefined;

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  if (!verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"))) {
    logger.warn("Twilio dial-result webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  const status = params.DialCallStatus ?? "unknown";
  const xml = () =>
    new NextResponse(dialFailedTwiML(status), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });

  // Connected → the recording callback will file the Call row with its audio.
  if (status === "completed" || status === "answered") {
    logger.info(`Click-to-call to lead ${leadId} connected (${params.DialCallDuration ?? "?"}s)`);
    return xml();
  }

  const summary = FAILED[status] ?? `The call ended (${status})`;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, phone: true } });
  logger.warn(
    `Click-to-call to lead ${leadId} did not connect: ${status}` +
      (params.DialCallSid ? ` (leg ${params.DialCallSid})` : ""),
  );

  // File it as an attempt so the lead's history shows the try. Idempotent on the
  // leg's CallSid, because Twilio retries webhooks.
  if (params.DialCallSid) {
    const seen = await prisma.call.findUnique({ where: { providerSid: params.DialCallSid } });
    if (seen) return xml();
  }
  await prisma.call
    .create({
      data: {
        leadId,
        callType: "human_handover",
        outcome: status === "no-answer" || status === "busy" ? "no_answer" : "unreachable",
        providerSid: params.DialCallSid || undefined,
        handledById: repId,
        transcript: `Call not connected — ${summary}${lead?.phone ? ` (dialled ${lead.phone})` : ""}.`,
      },
    })
    .catch((err) => logger.error(`Failed to log unconnected call for lead ${leadId}: ${String(err)}`));

  // The rep is off the phone again — undo the auto "in consultation" from the click.
  if (repId) await endConsultation(repId).catch(() => {});

  // And tell them in the app, since the call itself said nothing useful.
  if (repId) {
    await notifyRep(repId, {
      kind: "call_failed",
      title: `📵 Call didn't connect — ${lead?.name ?? "lead"}`,
      body: `${summary}${lead?.phone ? ` · dialled ${lead.phone}` : ""}. Check the number on the lead, then try again.`,
      leadId,
    });
  }

  return xml();
}
