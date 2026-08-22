// Played to the COUNSELLOR the moment they pick up an inbound patient call, before
// the caller is bridged. Two jobs:
//   1. Tell them who is on the line — and whether it's their own patient calling back.
//   2. Flip them to In-Consultation (§presence), so the next inbound call routes to
//      somebody else instead of ringing a handset that is already in use.
//
// This URL is only ever fetched by Twilio when the rep's leg answers, which makes it
// the earliest reliable "they actually picked up" signal we get.
import { NextResponse } from "next/server";
import { inboundWhisperTwiML, verifyTwilioSignature, publicBase } from "@/lib/providers/twilio";
import { beginConsultation } from "@/lib/presence";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  if (!verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"))) {
    logger.warn("Twilio inbound whisper: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const repId = url.searchParams.get("repId");
  const name = url.searchParams.get("name") ?? "a patient";
  const sticky = url.searchParams.get("sticky") === "1";

  // Best-effort: a presence hiccup must never stop the call connecting.
  if (repId) void beginConsultation(repId);

  return new NextResponse(inboundWhisperTwiML(name, sticky), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
