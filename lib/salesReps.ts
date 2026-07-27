// Sales rep roster + round-robin assignment (§3.1). Handovers are distributed
// to the least-recently-assigned active rep, so load spreads evenly across the
// team. Assignment is recorded on both the rep (cursor) and the lead.
import type { SalesRep } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/// Pick the next rep round-robin (least-recently-assigned AVAILABLE rep) and advance
/// the cursor. Sales heads are excluded — they're managers, not the rota. Only reps
/// whose availability is "available" are eligible (§presence): in-consultation, on
/// break, and offline counsellors are skipped so new leads never land with someone
/// who's stepped away. Returns null when no eligible reps are free.
export async function pickNextRep(): Promise<SalesRep | null> {
  const rep = await prisma.salesRep.findFirst({
    where: { active: true, salesHead: false, availability: "available" },
    orderBy: [{ lastAssignedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  if (!rep) return null;
  await prisma.salesRep.update({ where: { id: rep.id }, data: { lastAssignedAt: new Date() } });
  return rep;
}

/// Pick an AVAILABLE replacement when a lead's intended owner is unavailable
/// (§presence). Prefers a rep with the SAME speciality as the unavailable owner —
/// an offline counsellor's leads go to a colleague with the same skill — then falls
/// back to any available rep. Excludes the owner and advances the round-robin
/// cursor. Returns null when nobody else is free.
export async function pickReplacementFor(
  unavailable: { id: string; speciality: string | null },
): Promise<SalesRep | null> {
  const base = {
    active: true,
    salesHead: false,
    availability: "available",
    NOT: { id: unavailable.id },
  };
  let rep: SalesRep | null = null;
  if (unavailable.speciality) {
    rep = await prisma.salesRep.findFirst({
      where: { ...base, speciality: { equals: unavailable.speciality, mode: "insensitive" } },
      orderBy: [{ lastAssignedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    });
  }
  if (!rep) {
    rep = await prisma.salesRep.findFirst({
      where: base,
      orderBy: [{ lastAssignedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    });
  }
  if (!rep) return null;
  await prisma.salesRep.update({ where: { id: rep.id }, data: { lastAssignedAt: new Date() } });
  return rep;
}

/// The sales head (a manager, notified only on CQS extremes). Returns the first
/// active sales-head rep, or null if none is configured.
export async function getSalesHead(): Promise<SalesRep | null> {
  return prisma.salesRep.findFirst({ where: { active: true, salesHead: true } });
}

/// The rep who owns a lead (assigned at intake / handover), or null.
export async function getLeadOwner(leadId: string): Promise<SalesRep | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedRep: true },
  });
  return lead?.assignedRep ?? null;
}

/// Assign a lead to a rep (records who + when on the lead). Audited as a system
/// assignment (no human actor) — e.g. the round-robin at intake — so the ownership
/// trail is complete alongside manual handovers.
export async function assignLeadToRep(leadId: string, repId: string): Promise<void> {
  const before = await prisma.lead.findUnique({ where: { id: leadId }, select: { assignedRep: { select: { name: true } } } });
  const rep = await prisma.salesRep.findUnique({ where: { id: repId }, select: { name: true } });
  await prisma.lead.update({
    where: { id: leadId },
    data: { assignedRepId: repId, assignedAt: new Date() },
  });
  await writeAudit({
    action: "lead.assign", entityType: "lead", entityId: leadId,
    oldValue: before?.assignedRep?.name ?? "Unassigned", newValue: rep?.name ?? repId,
    meta: { repId, system: true },
  });
  logger.info(`Lead ${leadId} assigned to rep ${repId}`);
}
