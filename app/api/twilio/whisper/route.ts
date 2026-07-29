// Recording-disclosure whisper (§compliance C1). Twilio fetches this TwiML for the
// PATIENT leg of a human-handover click-to-call (via <Number url>) and plays it to
// them when they answer, before the two legs bridge — so the patient hears "this
// call is recorded". Twilio-only: verifies X-Twilio-Signature like the voice/
// recording webhooks. Static, no per-lead data.
import { NextResponse } from "next/server";
import { recordingWhisperTwiML, verifyTwilioSignature, publicBase } from "@/lib/providers/twilio";
import { logger } from "@/lib/logger";

function verify(req: Request, params: Record<string, string>): boolean {
  const url = new URL(req.url);
  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  return verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"));
}

function twiml(): NextResponse {
  return new NextResponse(recordingWhisperTwiML(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

const forbidden = () => {
  logger.warn("Twilio whisper webhook: bad signature");
  return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
};

export async function POST(req: Request) {
  const form = await req.formData();
  const body: Record<string, string> = {};
  for (const [k, v] of form.entries()) body[k] = String(v);
  if (!verify(req, body)) return forbidden();
  return twiml();
}
export async function GET(req: Request) {
  if (!verify(req, {})) return forbidden();
  return twiml();
}
