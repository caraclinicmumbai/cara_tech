// How a Plivo click-to-call ENDED. Plivo POSTs here when the <Dial> finishes, whatever the
// outcome — this is the only callback that fires when the patient leg never connects (wrong
// number, busy, no answer). The recording callback only fires on a call that happened, so
// without this a failed call would leave the counsellor in silence and the CRM with no trace.
//
// A connected call is left alone: the recording webhook owns that row and arrives with the
// audio. This route records the failures and tells the counsellor out loud why it ended.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyPlivoSignature,
  publicBase,
  dialFailedPlivoXML,
  plivoPatientCallerId,
} from "@/lib/providers/plivo";
import { endConsultation } from "@/lib/presence";
import { notifyRep } from "@/lib/notifications";
import { logger } from "@/lib/logger";

/// Plivo's DialBLegStatus / DialStatus values that mean "no conversation took place".
const FAILED: Record<string, string> = {
  busy: "The patient's line was busy",
  "no-answer": "The patient didn't answer",
  timeout: "The patient didn't answer",
  failed: "The call could not be placed",
  cancel: "The call was cancelled before it connected",
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
  if (
    !verifyPlivoSignature(
      signedUrl,
      params,
      req.headers.get("x-plivo-signature-v3"),
      req.headers.get("x-plivo-signature-v3-nonce"),
    )
  ) {
    logger.warn("Plivo dial-result webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  // Plivo names this differently depending on which callback fired; take whichever is set.
  const status = params.DialBLegStatus ?? params.DialStatus ?? params.CallStatus ?? "unknown";
  const xml = () =>
    new NextResponse(dialFailedPlivoXML(status), {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    });

  if (status === "completed" || status === "answered") {
    logger.info(`Plivo click-to-call to lead ${leadId} connected (${params.DialBLegDuration ?? "?"}s)`);
    return xml();
  }

  const summary = FAILED[status] ?? `The call ended (${status})`;
  // Log the caller ID we dialled FROM, not just the outcome: a failed leg looks identical
  // whether the lead's number is wrong or the provider refused our own caller ID, and when
  // it is the caller ID it fails for every patient at once.
  logger.warn(
    `Plivo click-to-call to lead ${leadId} did not connect: ${status}` +
      (params.DialBLegUUID ? ` (leg ${params.DialBLegUUID})` : "") +
      ` — dialled from ${plivoPatientCallerId() || "unset"}`,
  );

  // File it as an attempt so the lead's history shows the try. Idempotent on the leg's uuid,
  // because Plivo retries callbacks.
  const legId = params.DialBLegUUID || params.CallUUID;
  if (legId) {
    const seen = await prisma.call.findUnique({ where: { providerSid: legId } });
    if (seen) return xml();
  }
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, phone: true } });
  await prisma.call
    .create({
      data: {
        leadId,
        callType: "human_handover",
        provider: "plivo",
        outcome: "no_answer",
        providerSid: legId || undefined,
        handledById: repId,
      },
    })
    .catch((err) => logger.error(`Plivo dial-result: could not file the attempt: ${String(err)}`));

  if (repId) {
    void endConsultation(repId);
    await notifyRep(repId, {
      kind: "call_failed",
      title: `📵 Call didn't connect — ${lead?.name ?? "lead"}`,
      body: `${summary}${lead?.phone ? ` · dialled ${lead.phone}` : ""}. If this is happening on every call it is the caller ID, not this number.`,
      leadId,
    }).catch((err) => logger.error(`Plivo dial-result: notify failed: ${String(err)}`));
  }
  return xml();
}
