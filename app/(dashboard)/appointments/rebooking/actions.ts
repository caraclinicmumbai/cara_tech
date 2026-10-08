"use server";

// The "needs rebooking" worklist (§2.9). Anyone who books (`appointments.book`) may
// work it — but only for appointments at a branch they may act at (2.2.c), and the
// destination of a move follows the same rule.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { mayActAtBranch, viewerFor } from "@/lib/scheduling/calendar";
import { applyAlternative, setCaseStatus, suggestAlternatives, type RebookOption } from "@/lib/scheduling/conflicts";

type Result = { ok: boolean; error?: string; info?: string };

async function guard(caseId: string) {
  const user = await requireCapability("appointments.book");
  const viewer = await viewerFor(user);
  const c = await prisma.rebookingCase.findUnique({ where: { id: caseId }, select: { branchId: true } });
  if (!c) return { error: "Case not found" as const };
  if (!mayActAtBranch(viewer, c.branchId)) return { error: "This case belongs to another branch" as const };
  return { user, viewer };
}

export async function optionsForCase(caseId: string): Promise<{ ok: true; options: RebookOption[] } | { ok: false; error: string }> {
  const g = await guard(caseId);
  if ("error" in g) return { ok: false, error: g.error ?? "Not allowed" };
  const options = await suggestAlternatives(caseId);
  return { ok: true, options: options.filter((o) => mayActAtBranch(g.viewer, o.branchId)) };
}

export async function applyOption(caseId: string, option: { branchId: string; doctorId: string | null; startAt: string }): Promise<Result> {
  const g = await guard(caseId);
  if ("error" in g) return { ok: false, error: g.error };
  if (!mayActAtBranch(g.viewer, option.branchId)) return { ok: false, error: "You can't book at that branch" };
  const r = await applyAlternative(caseId, option, g.user);
  revalidatePath("/appointments/rebooking");
  revalidatePath("/appointments");
  return r;
}

export async function updateCase(caseId: string, status: "resolved" | "dismissed" | "patient_declined", note: string): Promise<Result> {
  const g = await guard(caseId);
  if ("error" in g) return { ok: false, error: g.error };
  const r = await setCaseStatus(caseId, status, note || null, g.user);
  revalidatePath("/appointments/rebooking");
  return r;
}
