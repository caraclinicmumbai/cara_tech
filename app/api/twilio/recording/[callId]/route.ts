// Session-gated proxy that streams a stored handover-call recording. Twilio media
// URLs need Basic auth, so the browser <audio> points here and we fetch the bytes
// server-side. Only serves recordings we logged against a Call.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/apiAuth";
import { fetchTwilioRecording } from "@/lib/providers/twilio";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ callId: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { callId } = await params;
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { recordingUrl: true },
  });
  if (!call?.recordingUrl) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const audio = await fetchTwilioRecording(call.recordingUrl);
  if (!audio) return NextResponse.json({ error: "Recording unavailable" }, { status: 502 });

  return new NextResponse(new Uint8Array(audio.buffer), {
    status: 200,
    headers: { "Content-Type": audio.mime, "Cache-Control": "private, max-age=3600" },
  });
}
