"use server";

// Booking a due treatment-plan session from the recall link (§2.8). The signed link is
// the credential for THIS step only; rate-limited; every call re-reads the step.
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { findSlots } from "@/lib/scheduling/booking";
import { bookStepAt, readRecallToken } from "@/lib/scheduling/series";
import { appointmentLink } from "@/lib/scheduling/links";
import { istDateKey } from "@/lib/scheduling/time";

async function guard(token: string) {
  const id = readRecallToken(token);
  if (!id) return null;
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await rateLimit(`recall:${id}:${ip}`, 60, 3600)).ok) return null;
  return prisma.plannedStep.findUnique({ where: { id }, include: { plan: true } });
}

export async function recallSlots(token: string, branchId: string, dateKey: string): Promise<{ startAt: string }[]> {
  const s = await guard(token);
  if (!s || s.status !== "planned" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || dateKey < istDateKey(new Date())) return [];
  const slots = await findSlots({ branchId, typeId: s.typeId, dateKey, resourceIds: s.sameDoctor && s.plan.doctorId ? [s.plan.doctorId] : [], excludeNeedsAck: true });
  const soonest = Date.now() + 3 * 3_600_000;
  return slots.filter((x) => x.startAt.getTime() >= soonest).map((x) => ({ startAt: x.startAt.toISOString() }));
}

export async function recallBook(token: string, branchId: string, startAt: string): Promise<{ ok: boolean; error?: string; link?: string }> {
  const s = await guard(token);
  if (!s) return { ok: false, error: "This link has expired — please call the clinic." };
  const when = new Date(startAt);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 3 * 3_600_000) return { ok: false, error: "Pick a later time." };
  const r = await bookStepAt(s.id, when, { id: null, email: "patient (recall link)" }, branchId);
  if (!r.ok) return { ok: false, error: r.error };
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id: r.appointmentId }, select: { endAt: true } });
  return { ok: true, link: appointmentLink(r.appointmentId, a.endAt) };
}
