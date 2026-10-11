// How a Plivo click-to-call ENDED. Plivo POSTs here when the <Dial> finishes, whatever the
// outcome — this is the only callback that fires when the patient leg never connects (wrong
// number, busy, no answer). The recording callback only fires on a call that happened, so
// without this a failed call would leave the counsellor in silence and the CRM with no trace.
//
// The Call row already exists — it was created when the counsellor pressed Call, and its id
// is on this url (lib/clickToCallLog.ts). This route is authoritative about the PATIENT leg,
// so it always writes: "connected" with the talk time, or why it never connected. It used to
// skip connected calls and leave them to the recording callback, which meant a connected
// call whose recording never arrived was never logged at all.
//
// Requests without a callId are calls placed before that change; they keep the old
// behaviour of filing a row only for a failure.
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
import { findClickToCall } from "@/lib/clickToCallLog";
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

  // Plivo's id for the counsellor's (A) leg — the one every callback on this call shares.
  const aLeg = params.DialALegUUID || params.CallUUID || undefined;
  const call = await findClickToCall(url.searchParams.get("callId"), leadId);

  if (status === "completed" || status === "answered") {
    const talk = parseInt(params.DialBLegDuration ?? "", 10);
    logger.info(`Plivo click-to-call to lead ${leadId} connected (${Number.isFinite(talk) ? talk : "?"}s)`);
    if (call) {
      await prisma.call
        .update({
          where: { id: call.id },
          data: {
            outcome: "connected",
            // Talk time with the patient — authoritative over the counsellor-leg length the
            // hang-up callback may have written first.
            ...(Number.isFinite(talk) ? { duration: talk } : {}),
            ...(aLeg && !call.providerSid ? { providerSid: aLeg } : {}),
          },
        })
        .catch((err) => logger.error(`Plivo dial-result: could not update call ${call.id}: ${String(err)}`));
    }
    return xml();
  }

  const summary = FAILED[status] ?? `The call ended (${status})`;
  // Log the caller ID we dialled FROM, not just the outcome: a failed leg looks identical
  // whether the lead's number is wrong or the provider refused our own caller ID, and when
  // it is the caller ID it fails for every patient at once.
  logger.warn(
    `Plivo click-to-call to lead ${leadId} did not connect: ${status}` +
      (params.DialBLegUUID ? ` (leg ${params.DialBLegUUID})` : "") +
      (params.DialHangupCause ? ` [${params.DialHangupCause}]` : "") +
      ` — dialled from ${plivoPatientCallerId() || "unset"}`,
  );

  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, phone: true } });
  const outcome = status === "no-answer" || status === "busy" || status === "timeout" ? "no_answer" : "unreachable";
  const note = `Call not connected — ${summary}${lead?.phone ? ` (dialled ${lead.phone})` : ""}.`;

  if (call) {
    // Plivo retries callbacks; a row already carrying this outcome has been told.
    if (call.outcome === outcome) return xml();
    await prisma.call
      .update({
        where: { id: call.id },
        data: { outcome, transcript: note, ...(aLeg && !call.providerSid ? { providerSid: aLeg } : {}) },
      })
      .catch((err) => logger.error(`Plivo dial-result: could not update call ${call.id}: ${String(err)}`));
  } else {
    // Legacy: a call placed before rows were created at the click. Idempotent on the leg's
    // uuid, because Plivo retries callbacks.
    const legId = params.DialBLegUUID || params.CallUUID;
    if (legId) {
      const seen = await prisma.call.findUnique({ where: { providerSid: legId } });
      if (seen) return xml();
    }
    await prisma.call
      .create({
        data: {
          leadId,
          callType: "human_handover",
          provider: "plivo",
          outcome,
          transcript: note,
          providerSid: legId || undefined,
          handledById: repId,
        },
      })
      .catch((err) => logger.error(`Plivo dial-result: could not file the attempt: ${String(err)}`));
  }

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
