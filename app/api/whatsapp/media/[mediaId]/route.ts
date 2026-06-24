// Session-gated proxy for inbound WhatsApp media (Phase 2). The <img>/download
// link on the lead thread points here; we resolve + stream the bytes from the
// Graph API (which needs the bearer token and short-lived URLs) so the token
// never reaches the browser. Only media we actually logged can be fetched.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/apiAuth";
import { fetchWhatsAppMedia } from "@/lib/providers/whatsapp";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { mediaId } = await params;

  // Only serve media we've recorded against a message (no arbitrary fetches).
  const known = await prisma.message.findFirst({ where: { mediaId }, select: { id: true } });
  if (!known) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const media = await fetchWhatsAppMedia(mediaId);
  if (!media) return NextResponse.json({ error: "Media unavailable" }, { status: 502 });

  return new NextResponse(new Uint8Array(media.buffer), {
    status: 200,
    headers: {
      "Content-Type": media.mime,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
