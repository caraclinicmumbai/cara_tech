// Session-gated proxy that streams a recorded AI (ElevenLabs) call's audio. The
// ElevenLabs conversation-audio endpoint needs the API key, so the browser <audio>
// points here and we fetch the bytes server-side. Only serves calls we logged with
// an ElevenLabs conversation id.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/apiAuth";
import { fetchConversationAudio } from "@/lib/providers/elevenlabs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ callId: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { callId } = await params;
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { elevenlabsId: true },
  });
  if (!call?.elevenlabsId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const audio = await fetchConversationAudio(call.elevenlabsId);
  if (!audio) return NextResponse.json({ error: "Recording unavailable" }, { status: 502 });

  return new NextResponse(new Uint8Array(audio.buffer), {
    status: 200,
    headers: { "Content-Type": audio.mime, "Cache-Control": "private, max-age=3600" },
  });
}
