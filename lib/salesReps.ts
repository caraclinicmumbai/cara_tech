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

/// Pick the OWNER for a brand-new lead. Same round-robin as pickNextRep, but it
/// never comes back empty-handed while any active counsellor exists: ownership is
/// "whose lead is this to follow up", not "who can pick up the phone this minute",
/// so a team that is entirely on break/offline must still end up with an owner —
/// otherwise the lead lands nowhere, drops out of every "my leads" view, and there
/// is nobody for the later handover to notify. Availability is still PREFERRED, so
/// the rota keeps favouring people who are actually at their desk.
/// `preferAvailable: false` ignores presence entirely and spreads strictly by the
/// rota — for backfilling historical leads, where "who is at their desk right now"
/// is meaningless and piling every old lead on the one available rep is worse.
export async function pickOwnerRep(
  opts: { preferAvailable?: boolean } = {},
): Promise<SalesRep | null> {
  const base = { active: true, salesHead: false };
  const order = [
    { lastAssignedAt: { sort: "asc" as const, nulls: "first" as const } },
    { createdAt: "asc" as const },
  ];
  const rep =
    (opts.preferAvailable === false
      ? null
      : await prisma.salesRep.findFirst({ where: { ...base, availability: "available" }, orderBy: order })) ??
    (await prisma.salesRep.findFirst({ where: base, orderBy: order }));
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
