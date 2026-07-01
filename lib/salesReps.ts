// Sales rep roster + round-robin assignment (§3.1). Handovers are distributed
// to the least-recently-assigned active rep, so load spreads evenly across the
// team. Assignment is recorded on both the rep (cursor) and the lead.
import type { SalesRep } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/// Pick the next rep round-robin (least-recently-assigned active rep) and advance
/// the cursor. Sales heads are excluded — they're managers, not the rota. Returns
/// null when no eligible reps are configured.
export async function pickNextRep(): Promise<SalesRep | null> {
  const rep = await prisma.salesRep.findFirst({
    where: { active: true, salesHead: false },
    orderBy: [{ lastAssignedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  if (!rep) return null;
  await prisma.salesRep.update({ where: { id: rep.id }, data: { lastAssignedAt: new Date() } });
  return rep;
}

/// The sales head (a manager, notified only on CQS extremes). Returns the first
/// active sales-head rep, or null if none is configured.
export async function getSalesHead(): Promise<SalesRep | null> {
  return prisma.salesRep.findFirst({ where: { active: true, salesHead: true } });
}

/// Assign a lead to a rep (records who + when on the lead).
export async function assignLeadToRep(leadId: string, repId: string): Promise<void> {
  await prisma.lead.update({
    where: { id: leadId },
    data: { assignedRepId: repId, assignedAt: new Date() },
  });
  logger.info(`Lead ${leadId} assigned to rep ${repId}`);
}
