// XML served to Plivo when the counsellor answers a click-to-call: start a background
// recording of the session, then dial the lead. Plivo-only — the request must carry a valid
// X-Plivo-Signature-V3 (§security S3); without that check this route would hand the
// patient's phone number to anyone who guesses the cuid. Returns XML.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dialLeadPlivoXML, verifyPlivoSignature, publicBase } from "@/lib/providers/plivo";
import { logger } from "@/lib/logger";

async function xmlFor(leadId: string, repId?: string): Promise<NextResponse> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
  const body = lead
    ? dialLeadPlivoXML(lead.phone, leadId, repId)
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Lead not found.</Speak><Hangup/></Response>`;
  return new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function repIdFrom(req: Request): string | undefined {
  return new URL(req.url).searchParams.get("repId") ?? undefined;
}

/// Verify over the exact PUBLIC url Plivo signed. `req.url` is the internal url the platform
/// saw, which behind Railway's proxy is not what Plivo requested, so the public base is
/// substituted — same reasoning as the Twilio routes.
function verify(req: Request, params: Record<string, string>, method: "POST" | "GET"): boolean {
  const url = new URL(req.url);
  const signedUrl = `${publicBase()}${url.pathname}${url.search}`;
  return verifyPlivoSignature(
    signedUrl,
    params,
    req.headers.get("x-plivo-signature-v3"),
    req.headers.get("x-plivo-signature-v3-nonce"),
    method,
  );
}

const forbidden = () => {
  logger.warn("Plivo voice webhook: bad signature");
  return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
};

export async function POST(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const form = await req.formData();
  const body: Record<string, string> = {};
  for (const [k, v] of form.entries()) body[k] = String(v);
  if (!verify(req, body, "POST")) return forbidden();
  return xmlFor((await params).leadId, repIdFrom(req));
}

export async function GET(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  // GET is signed over the url alone — there is no body to fold in.
  if (!verify(req, {}, "GET")) return forbidden();
  return xmlFor((await params).leadId, repIdFrom(req));
}
