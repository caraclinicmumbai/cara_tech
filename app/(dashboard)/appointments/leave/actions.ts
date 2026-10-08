"use server";

// Leave & availability actions (§2.9). Who may do what:
//   - anyone whose login is a doctor/staff resource: request THEIR OWN leave, cancel
//     their own request;
//   - `appointments.approveLeave` (head office) or `appointments.configure`: enter
//     leave for anyone (approved at once), approve / reject requests, cancel any leave,
//     mark an emergency.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/datetime";
import { viewerFor } from "@/lib/scheduling/calendar";
import { affectedCount, cancelLeave, decideLeave, markEmergency, requestLeave } from "@/lib/scheduling/leave";

type Result = { ok: boolean; error?: string; info?: string; affected?: number };

async function manager() {
  const user = await requireUser();
  await ensurePermissions();
  const isManager = can(user.role, "appointments.approveLeave") || can(user.role, "appointments.configure");
  return { user, isManager, canApprove: can(user.role, "appointments.approveLeave") };
}

/// "YYYY-MM-DD" (whole days) or "YYYY-MM-DDTHH:mm". A bare end date means through the
/// end of that day.
function parseRange(start: string, end: string): { startAt: Date; endAt: Date } | null {
  const startAt = parseIstDateTimeLocal(start);
  let endAt = parseIstDateTimeLocal(end || start);
  if (!startAt || !endAt) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test((end || start).trim())) endAt = new Date(endAt.getTime() + 86_400_000);
  return endAt > startAt ? { startAt, endAt } : null;
}

export async function previewLeave(resourceId: string, start: string, end: string): Promise<number> {
  await requireUser();
  const r = parseRange(start, end);
  return r ? affectedCount(resourceId, r.startAt, r.endAt) : 0;
}

export async function requestMyLeave(input: { start: string; end: string; kind: string; reason: string }): Promise<Result> {
  const user = await requireUser();
  const viewer = await viewerFor(user);
  if (!viewer.resourceId) return { ok: false, error: "Your login isn't linked to a doctor or staff calendar — ask an admin to link it in Scheduling setup." };
  const r = parseRange(input.start, input.end);
  if (!r) return { ok: false, error: "Pick a start and an end after it" };
  const res = await requestLeave({ resourceId: viewer.resourceId, ...r, kind: input.kind, reason: input.reason }, user);
  revalidatePath("/appointments/leave");
  return res;
}

export async function enterLeaveFor(input: { resourceId: string; start: string; end: string; kind: string; reason: string }): Promise<Result> {
  const { user, isManager } = await manager();
  if (!isManager) return { ok: false, error: "You don't have permission for that" };
  const r = parseRange(input.start, input.end);
  if (!r) return { ok: false, error: "Pick a start and an end after it" };
  const res = await requestLeave({ resourceId: input.resourceId, ...r, kind: input.kind, reason: input.reason, approveNow: true }, user);
  revalidatePath("/appointments/leave");
  revalidatePath("/appointments");
  return res;
}

export async function decideLeaveRequest(id: string, approve: boolean, note: string): Promise<Result> {
  const { user, canApprove } = await manager();
  if (!canApprove) return { ok: false, error: "Only head office can approve leave" };
  const res = await decideLeave(id, approve, note || null, user);
  revalidatePath("/appointments/leave");
  revalidatePath("/appointments");
  return res;
}

export async function cancelLeaveEntry(id: string): Promise<Result> {
  const { user, isManager } = await manager();
  const row = await prisma.resourceTimeOff.findUnique({ where: { id }, select: { requestedById: true, resource: { select: { userId: true } } } });
  if (!row) return { ok: false, error: "Leave not found" };
  const own = !!user.id && (row.requestedById === user.id || row.resource.userId === user.id);
  if (!own && !isManager) return { ok: false, error: "You can only withdraw your own leave" };
  const res = await cancelLeave(id, user);
  revalidatePath("/appointments/leave");
  revalidatePath("/appointments");
  return res;
}

export async function markDoctorEmergency(resourceId: string, reason: string): Promise<Result> {
  const { user, isManager } = await manager();
  if (!isManager) return { ok: false, error: "You don't have permission for that" };
  const res = await markEmergency(resourceId, reason, user);
  revalidatePath("/appointments/leave");
  revalidatePath("/appointments");
  return res;
}
