// Uploads a SAMPLE media file for a media-header template (§template builder).
// The browser posts the file here; we run Meta's resumable upload server-side (it
// needs the WhatsApp token + Meta App ID) and return the header handle, which the
// builder then submits with the template. Gated to templates.manage.
import { NextResponse } from "next/server";
import { requireApiCapability } from "@/lib/apiAuth";
import { uploadSampleMedia } from "@/lib/whatsappTemplates";

// Meta sample-media caps (generous headroom; Meta enforces the exact limits).
const MAX_BYTES = 16 * 1024 * 1024;

export async function POST(req: Request) {
  const { denied } = await requireApiCapability("templates.manage");
  if (denied) return denied;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "File is empty" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File too large (max 16 MB)" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "application/octet-stream";
  const res = await uploadSampleMedia(buffer, mime, file.name || "sample");
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ handle: res.handle }, { status: 200 });
}
