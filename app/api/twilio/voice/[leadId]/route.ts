// TwiML served to Twilio when the rep answers a click-to-call: it dials the lead
// and records the bridged call. Public (Twilio calls it); the leadId is a cuid so
// it isn't guessable. Returns XML.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dialLeadTwiML } from "@/lib/providers/twilio";

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

// Twilio defaults to POST for the call Url, but allow GET too.
export async function POST(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  return twiml((await params).leadId, repIdFrom(req));
}
export async function GET(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  return twiml((await params).leadId, repIdFrom(req));
}
