// TwiML served to Twilio when the rep answers a click-to-call: it dials the lead
// and records the bridged call. Twilio-only — the request must carry a valid
// X-Twilio-Signature (§ security S3); otherwise this would leak the patient's
// phone number to anyone who guesses the cuid. Returns XML.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dialLeadTwiML, verifyTwilioSignature, publicBase } from "@/lib/providers/twilio";
import { logger } from "@/lib/logger";

async function twiml(leadId: string, repId?: string): Promise<NextResponse> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
  const xml = lead
    ? dialLeadTwiML(lead.phone, leadId, repId)
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Lead not found.</Say><Hangup/></Response>`;
  return new NextResponse(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function repIdFrom(req: Request): string | undefined {
  return new URL(req.url).searchParams.get("repId") ?? undefined;
}

// Verify the Twilio signature over the exact public URL Twilio signed (base + path
// + query, including repId) plus any POST params — mirrors the recording webhook.
function verify(req: Request, params: Record<string, string>): boolean {
  const url = new URL(req.url);
  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  return verifyTwilioSignature(signedUrl, params, req.headers.get("x-twilio-signature"));
}

const forbidden = () => {
  logger.warn("Twilio voice webhook: bad signature");
  return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
};

// Twilio defaults to POST for the call Url, but allow GET too.
export async function POST(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const form = await req.formData();
  const body: Record<string, string> = {};
  for (const [k, v] of form.entries()) body[k] = String(v);
  if (!verify(req, body)) return forbidden();
  return twiml((await params).leadId, repIdFrom(req));
}
export async function GET(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  // GET requests are signed over the full URL alone (no body params).
  if (!verify(req, {})) return forbidden();
  return twiml((await params).leadId, repIdFrom(req));
}
