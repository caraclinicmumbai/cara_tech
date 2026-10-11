// The COUNSELLOR's leg of a Twilio click-to-call has ended (`StatusCallback`, set in
// lib/providers/twilio.ts). Twilio's counterpart of app/api/plivo/hangup — see that file and
// lib/clickToCallLog.ts for why it exists and why it only writes while the row is "ringing".
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyTwilioSignature, publicBase } from "@/lib/providers/twilio";
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
  if (!verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"))) {
    logger.warn("Twilio call-status webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  if (!leadId) return NextResponse.json({ error: "Missing leadId" }, { status: 400 });

  const status = params.CallStatus ?? "unknown";
  // "completed" means the counsellor answered, so the patient was dialled; if no
  // dial-result has landed, the call ended before the patient picked up.
  const repAnswered = status === "completed";
  logger.info(`Click-to-call to lead ${leadId}: counsellor leg ended (${status})`);

  const call = await findClickToCall(url.searchParams.get("callId"), leadId);
  if (call) {
    await prisma.call
      .updateMany({
        where: { id: call.id, outcome: "ringing" },
        data: repAnswered
          ? { outcome: "cancelled", transcript: "The call ended before the patient answered." }
          : {
              outcome: "rep_missed",
              transcript: `The counsellor's phone wasn't answered (${status}), so the patient was never dialled.`,
            },
      })
      .catch((err) => logger.error(`Twilio call-status: could not settle call ${call.id}: ${String(err)}`));
    if (params.CallSid) {
      await prisma.call
        .updateMany({ where: { id: call.id, providerSid: null }, data: { providerSid: params.CallSid } })
        .catch(() => {});
    }
  }

  if (repId) void endConsultation(repId);
  return NextResponse.json({ ok: true }, { status: 200 });
}
