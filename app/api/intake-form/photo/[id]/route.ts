// A patient's intake photo (§2.7) — staff only: `appointments.viewIntake`, AND the viewer
// must be able to see the appointment it belongs to (lib/scheduling/calendar.ts
// userSeesIntake). The role alone used to be enough, which let any doctor open any
// branch's patient photos by id. Never cached by shared caches.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { userSeesIntake } from "@/lib/scheduling/calendar";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  await ensurePermissions();
  if (!user || !can(user.role, "appointments.viewIntake")) return new NextResponse("Forbidden", { status: 403 });
  const { id } = await params;
  const p = await prisma.intakePhoto.findUnique({ where: { id }, select: { bytes: true, mime: true, responseId: true } });
  // Not found and not allowed answer the same, so an id can't be probed.
  if (!p || !(await userSeesIntake(user, p.responseId))) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(Buffer.from(p.bytes), { headers: { "Content-Type": p.mime, "Cache-Control": "private, no-store" } });
}
