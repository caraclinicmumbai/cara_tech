// TwiML served to Twilio when the rep answers a click-to-call: it dials the lead
// and records the bridged call. Public (Twilio calls it); the leadId is a cuid so
// it isn't guessable. Returns XML.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dialLeadTwiML } from "@/lib/providers/twilio";

async function twiml(leadId: string): Promise<NextResponse> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { phone: true } });
  const xml = lead
    ? dialLeadTwiML(lead.phone, leadId)
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Lead not found.</Say><Hangup/></Response>`;
  return new NextResponse(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

// Twilio defaults to POST for the call Url, but allow GET too.
export async function POST(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  return twiml((await params).leadId);
}
export async function GET(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  return twiml((await params).leadId);
}
