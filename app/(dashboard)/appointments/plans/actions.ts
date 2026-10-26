"use server";

// Treatment-plan actions (§2.8). Booking and editing a patient's plan needs
// `appointments.book` and the branch rule (2.2.c) for the plan's branch.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { findSlots } from "@/lib/scheduling/booking";
import { mayActAtBranch, viewerFor } from "@/lib/scheduling/calendar";
import { bookStepAt, createPlan, extendStep, prebookStep, retargetStep, waiveStep } from "@/lib/scheduling/series";

type Result = { ok: boolean; error?: string; info?: string; id?: string };

async function guardPlan(planId: string) {
  const user = await requireCapability("appointments.book");
  const viewer = await viewerFor(user);
  const plan = await prisma.treatmentPlan.findUnique({ where: { id: planId }, select: { branchId: true, leadId: true } });
  if (!plan) return { error: "Plan not found" as const };
  if (!mayActAtBranch(viewer, plan.branchId)) return { error: "This plan belongs to another branch" as const };
  return { user, plan };
}
async function guardStep(stepId: string): Promise<{ error: string } | { user: Awaited<ReturnType<typeof requireCapability>>; planId: string }> {
  const s = await prisma.plannedStep.findUnique({ where: { id: stepId }, select: { planId: true } });
  if (!s) return { error: "Step not found" };
  const g = await guardPlan(s.planId);
  if ("error" in g) return { error: g.error ?? "Not allowed" };
  return { user: g.user, planId: s.planId };
}

export async function startPlanFromAppointment(appointmentId: string, templateId: string): Promise<Result> {
  const user = await requireCapability("appointments.book");
  const viewer = await viewerFor(user);
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { leadId: true, branchId: true } });
  if (!a) return { ok: false, error: "Appointment not found" };
  if (!mayActAtBranch(viewer, a.branchId)) return { ok: false, error: "This appointment belongs to another branch" };
  const r = await createPlan({ leadId: a.leadId, templateId, anchorAppointmentId: appointmentId, actor: user });
  if (!r.ok) return r;
  revalidatePath("/appointments");
  return { ok: true, id: r.planId, info: r.prebooked ? `Plan started — ${r.prebooked} upcoming session(s) pre-booked` : "Plan started" };
}

export async function stepSlots(stepId: string, dateKey: string): Promise<{ startAt: string }[]> {
  const g = await guardStep(stepId);
  if ("error" in g) return [];
  const s = await prisma.plannedStep.findUniqueOrThrow({ where: { id: stepId }, include: { plan: true } });
  const slots = await findSlots({ branchId: s.plan.branchId, typeId: s.typeId, dateKey, resourceIds: s.sameDoctor && s.plan.doctorId ? [s.plan.doctorId] : [] });
  return slots.filter((x) => x.startAt.getTime() > Date.now()).map((x) => ({ startAt: x.startAt.toISOString() }));
}

export async function bookStep(stepId: string, startAt: string): Promise<Result> {
  const g = await guardStep(stepId);
  if ("error" in g) return { ok: false, error: g.error };
  const r = await bookStepAt(stepId, new Date(startAt), g.user);
  revalidatePath(`/appointments/plans/${g.planId}`);
  return r.ok ? { ok: true, info: "Booked" } : r;
}

export async function extendPlanStep(stepId: string, days: number, reason: string): Promise<Result> {
  const g = await guardStep(stepId);
  if ("error" in g) return { ok: false, error: g.error };
  const r = await extendStep(stepId, days, reason, g.user);
  revalidatePath(`/appointments/plans/${g.planId}`);
  return r;
}

export async function waivePlanStep(stepId: string, reason: string): Promise<Result> {
  const g = await guardStep(stepId);
  if ("error" in g) return { ok: false, error: g.error };
  const r = await waiveStep(stepId, reason, g.user);
  revalidatePath(`/appointments/plans/${g.planId}`);
  return r;
}

export async function retargetPlanStep(stepId: string, dateKey: string): Promise<Result> {
  const g = await guardStep(stepId);
  if ("error" in g) return { ok: false, error: g.error };
  const r = await retargetStep(stepId, dateKey, g.user);
  revalidatePath(`/appointments/plans/${g.planId}`);
  return r;
}

export async function markPlanReviewed(planId: string): Promise<Result> {
  const g = await guardPlan(planId);
  if ("error" in g) return { ok: false, error: g.error };
  await prisma.treatmentPlan.update({ where: { id: planId }, data: { needsReview: false, reviewNote: null } });
  await writeAudit({ actorId: g.user.id, actorEmail: g.user.email, action: "series.plan.reviewed", entityType: "lead", entityId: g.plan.leadId, meta: { planId } });
  revalidatePath(`/appointments/plans/${planId}`);
  return { ok: true };
}

export async function cancelPlan(planId: string, reason: string): Promise<Result> {
  const g = await guardPlan(planId);
  if ("error" in g) return { ok: false, error: g.error };
  if (!reason.trim()) return { ok: false, error: "Give a reason" };
  await prisma.treatmentPlan.update({ where: { id: planId }, data: { status: "cancelled", reviewNote: reason.trim() } });
  await writeAudit({ actorId: g.user.id, actorEmail: g.user.email, action: "series.plan.cancel", entityType: "lead", entityId: g.plan.leadId, reason: reason.trim(), meta: { planId } });
  revalidatePath(`/appointments/plans/${planId}`);
  return { ok: true, info: "Plan cancelled. Booked sessions are kept — cancel them from the calendar if needed." };
}

/// Set the plan's surgeon (2.8.f) — e.g. a plan started from an appointment with no
/// doctor. Then pre-book whatever is due within 30 days (2.8.b) with them.
export async function setPlanDoctor(planId: string, doctorId: string): Promise<Result> {
  const g = await guardPlan(planId);
  if ("error" in g) return { ok: false, error: g.error };
  const doc = await prisma.resource.findFirst({ where: { id: doctorId, kind: "doctor", active: true }, select: { name: true } });
  if (!doc) return { ok: false, error: "Pick a doctor" };
  await prisma.treatmentPlan.update({ where: { id: planId }, data: { doctorId } });
  await writeAudit({ actorId: g.user.id, actorEmail: g.user.email, action: "series.plan.doctor", entityType: "lead", entityId: g.plan.leadId, newValue: doc.name, meta: { planId } });
  const soon = await prisma.plannedStep.findMany({ where: { planId, status: "planned", targetAt: { lte: new Date(Date.now() + 30 * 86_400_000) } }, select: { id: true } });
  let booked = 0;
  for (const s of soon) if (await prebookStep(s.id, g.user)) booked++;
  revalidatePath(`/appointments/plans/${planId}`);
  return { ok: true, info: booked ? `${doc.name} set — ${booked} session(s) pre-booked` : `${doc.name} set` };
}
