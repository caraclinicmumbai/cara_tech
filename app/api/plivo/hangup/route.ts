// The COUNSELLOR's leg of a Plivo click-to-call has ended (`hangup_url`, set in
// lib/providers/plivo.ts). It fires however the call went — including when the counsellor's
// own phone was never answered, which is the one case no other callback covers: the answer
// XML is never fetched, so there is no dial and no recording.
//
// This is the safety net, not the source of truth (see lib/clickToCallLog.ts). It only
// settles the row while it is still "ringing"; if dial-result or the recording has already
// said what happened to the patient leg, that stands. It always ends the counsellor's
// auto "In consultation", which nothing else did for a call that never reached the patient.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPlivoSignature, publicBase } from "@/lib/providers/plivo";
import { endConsultation } from "@/lib/presence";
import { findClickToCall } from "@/lib/clickToCallLog";
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
    logger.warn("Plivo hangup webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  const status = params.CallStatus ?? "unknown";
  const cause = params.HangupCause ?? "";
  // "completed" means the counsellor answered. Then the patient leg was dialled, and if no
  // dial-result has landed the call ended before the patient picked up.
  const repAnswered = status === "completed";
  logger.info(
    `Plivo click-to-call to lead ${leadId}: counsellor leg ended (${status}${cause ? `, ${cause}` : ""})`,
  );

  const call = await findClickToCall(url.searchParams.get("callId"), leadId);
  if (call) {
    // No duration is written from here: this leg's length is mostly ringing, and Call.duration
    // means time spent talking to the patient — dial-result and the recording supply that.
    // Only while nothing better has reported — a single conditional update, so a dial-result
    // landing at the same moment wins rather than being overwritten.
    await prisma.call
      .updateMany({
        where: { id: call.id, outcome: "ringing" },
        data: repAnswered
          ? {
              outcome: "cancelled",
              transcript: "The call ended before the patient answered.",
            }
          : {
              outcome: "rep_missed",
              transcript:
                `The counsellor's phone wasn't answered (${status}${cause ? `, ${cause}` : ""}), ` +
                `so the patient was never dialled.`,
            },
      })
      .catch((err) => logger.error(`Plivo hangup: could not settle call ${call.id}: ${String(err)}`));
    if (call.providerSid == null && params.CallUUID) {
      await prisma.call
        .updateMany({ where: { id: call.id, providerSid: null }, data: { providerSid: params.CallUUID } })
        .catch(() => {});
    }
  }

  if (repId) void endConsultation(repId);
  return NextResponse.json({ ok: true }, { status: 200 });
}
