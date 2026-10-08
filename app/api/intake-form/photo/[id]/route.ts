// A patient's intake photo (§2.7) — staff only, `appointments.viewIntake`. Never
// cached by shared caches; every view goes through this check.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  await ensurePermissions();
  if (!user || !can(user.role, "appointments.viewIntake")) return new NextResponse("Forbidden", { status: 403 });
  const { id } = await params;
  const p = await prisma.intakePhoto.findUnique({ where: { id }, select: { bytes: true, mime: true } });
  if (!p) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(Buffer.from(p.bytes), { headers: { "Content-Type": p.mime, "Cache-Control": "private, no-store" } });
}
