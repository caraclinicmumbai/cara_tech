// Send a chat attachment (photo / video / voice note / document) to a lead over
// WhatsApp (§WhatsApp attachments). A route handler rather than a Server Action
// because attachments run to 100 MB and Server Actions cap request bodies at 1 MB.
// The composer posts one file (+ optional caption) at a time.
import { NextResponse } from "next/server";
import { requireApiCapability } from "@/lib/apiAuth";
import { sendLeadAttachment } from "@/lib/messages";
import { classifyAttachment } from "@/lib/whatsappMedia";

const CAPTION_MAX = 1024; // Meta's media caption limit

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied, email } = await requireApiCapability("leads.whatsapp");
  if (denied) return denied;
  const { id } = await params;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  const caption = String(form?.get("caption") ?? "").trim().slice(0, CAPTION_MAX) || undefined;

  const filename = file.name || "attachment";
  const verdict = classifyAttachment(filename, file.type, file.size);
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });

  const res = await sendLeadAttachment(
    id,
    { buffer: Buffer.from(await file.arrayBuffer()), filename, mime: verdict.mime, kind: verdict.kind },
    caption,
    { sentBy: email },
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ ok: true }, { status: 200 });
}
