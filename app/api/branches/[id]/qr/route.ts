// Upload a branch's scan-to-pay QR image (§branches). The browser posts the file here;
// we store the bytes on the Branch row (survives Railway redeploys, unlike the
// filesystem) and the quote PDF embeds them. Gated to branches.manage.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiCapability } from "@/lib/apiAuth";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB — plenty for a QR PNG/JPEG

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied } = await requireApiCapability("branches.manage");
  if (denied) return denied;

  const { id } = await params;
  const branch = await prisma.branch.findUnique({ where: { id }, select: { id: true } });
  if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "File is empty" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Image too large (max 4 MB)" }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ error: "Must be an image" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  await prisma.branch.update({ where: { id }, data: { qrImage: bytes } });
  return NextResponse.json({ ok: true }, { status: 200 });
}

/// Remove a branch's QR image.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied } = await requireApiCapability("branches.manage");
  if (denied) return denied;
  const { id } = await params;
  await prisma.branch.update({ where: { id }, data: { qrImage: null } }).catch(() => null);
  return NextResponse.json({ ok: true }, { status: 200 });
}
