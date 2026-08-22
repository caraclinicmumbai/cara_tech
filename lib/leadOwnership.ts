// Lead handover + temporary access grants (§handover). Ownership = Lead.assignedRepId
// (a SalesRep). A handover transfers it; a grant lets a colleague ACT on the lead
// without changing the owner. Both are recorded to AuditLog (the lead timeline) and
// best-effort Slack-DM the counsellor.
//
// Rules:
//  - Handover: only the current owner or a manager/admin may do it. "Same branch"
//    (owner rep's branch == target rep's branch) is fine; "cross-branch" (both branches
//    known and different) requires a manager/admin AND a written reason.
//  - Grant/revoke: managers/admin only (gated by the leads.grantAccess capability at the
//    action layer).
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { logger } from "@/lib/logger";

export class OwnershipError extends Error {}

type Actor = { id?: string; email?: string | null; salesRepId?: string | null; isManager: boolean };

/// Best-effort Slack DM to a counsellor (by their rep's Slack id). Never throws.
async function dm(slackUserId: string | null | undefined, text: string): Promise<void> {
  if (!slackUserId || !isSlackConfigured()) return;
  await sendSlack({ text, channel: slackUserId }).catch(() => {});
}

/// Transfer a lead's owner to another counsellor (rep). Enforces the owner/manager +
/// cross-branch rules. Returns whether it was a cross-branch move.
export async function handoverLead(input: {
  leadId: string;
  toRepId: string;
  reason?: string | null;
  actor: Actor;
}): Promise<{ crossBranch: boolean; toRepName: string }> {
  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, name: true, phone: true, assignedRepId: true, assignedRep: { select: { name: true, branchId: true } } },
  });
  if (!lead) throw new OwnershipError("Lead not found");

  const toRep = await prisma.salesRep.findUnique({
    where: { id: input.toRepId },
    select: { id: true, name: true, active: true, branchId: true, slackUserId: true },
  });
  if (!toRep) throw new OwnershipError("Counsellor not found");
  if (!toRep.active) throw new OwnershipError("That counsellor is inactive");
  if (lead.assignedRepId === toRep.id) throw new OwnershipError("That counsellor already owns this lead");

  // Only the current owner or a manager/admin may hand over (a covering colleague can't).
  const isOwner = !!input.actor.salesRepId && input.actor.salesRepId === lead.assignedRepId;
  if (!input.actor.isManager && !isOwner) {
    throw new OwnershipError("Only the lead's owner or a manager can hand it over");
  }

  // Cross-branch only when BOTH branches are known and differ (permissive while branches
  // are still being assigned). Then a manager + written reason are required.
  const ownerBranch = lead.assignedRep?.branchId ?? null;
  const crossBranch = !!ownerBranch && !!toRep.branchId && ownerBranch !== toRep.branchId;
  const reason = (input.reason ?? "").trim();
  if (crossBranch) {
    if (!input.actor.isManager) throw new OwnershipError("Cross-branch handovers need a manager or admin");
    if (!reason) throw new OwnershipError("A written reason is required for a cross-branch handover");
  }

  await prisma.lead.update({ where: { id: lead.id }, data: { assignedRepId: toRep.id, assignedAt: new Date() } });
  await writeAudit({
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    action: "lead.handover",
    entityType: "lead",
    entityId: lead.id,
    oldValue: lead.assignedRep?.name ?? "Unassigned",
    newValue: toRep.name,
    reason: reason || null,
    meta: { crossBranch, toRepId: toRep.id },
  });
  await dm(toRep.slackUserId, `🔁 You've been handed lead *${lead.name}* (${lead.phone})${reason ? ` — ${reason}` : ""}.`);
  logger.info(`Lead ${lead.id} handed to rep ${toRep.id} by ${input.actor.email ?? "?"}${crossBranch ? " (cross-branch)" : ""}`);
  return { crossBranch, toRepName: toRep.name };
}

/// Grant a colleague temporary access to a lead (no ownership change), with an optional
/// expiry. Recorded + Slack-DM'd. The action layer gates this to leads.grantAccess.
export async function grantLeadAccess(input: {
  leadId: string;
  granteeUserId: string;
  reason?: string | null;
  durationDays?: number | null;
  actor: { id?: string; email?: string | null };
}): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: input.leadId }, select: { id: true, name: true, phone: true } });
  if (!lead) throw new OwnershipError("Lead not found");
  const grantee = await prisma.user.findUnique({
    where: { id: input.granteeUserId },
    select: { id: true, name: true, email: true, salesRep: { select: { slackUserId: true } } },
  });
  if (!grantee) throw new OwnershipError("User not found");

  const days = input.durationDays ?? null;
  const expiresAt = days && days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
  const reason = (input.reason ?? "").trim() || null;

  await prisma.leadAccessGrant.create({
    data: { leadId: lead.id, granteeId: grantee.id, grantedById: input.actor.id ?? null, reason, expiresAt },
  });
  await writeAudit({
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    action: "lead.access.grant",
    entityType: "lead",
    entityId: lead.id,
    newValue: grantee.name ?? grantee.email,
    reason,
    meta: { granteeId: grantee.id, expiresAt: expiresAt?.toISOString() ?? null },
  });
  await dm(
    grantee.salesRep?.slackUserId,
    `🔓 You've been granted temporary access to lead *${lead.name}* (${lead.phone})${expiresAt ? ` until ${expiresAt.toDateString()}` : ""}${reason ? ` — ${reason}` : ""}.`,
  );
  logger.info(`Access to lead ${lead.id} granted to user ${grantee.id} by ${input.actor.email ?? "?"}`);
}

/// How long a presence-driven cover grant lasts. Long enough to work the lead over a
/// couple of shifts, short enough that access lapses on its own once the owner is back.
export const COVER_GRANT_DAYS = 2;

/// Let a colleague ACT on a lead whose owner is unavailable (§presence + §handover),
/// WITHOUT moving ownership: the lead still belongs to the counsellor it was assigned
/// at intake, and this access expires by itself. Used by the automated handover, so
/// there's no human actor — it's audited as a system grant.
///
/// Idempotent: an existing live grant for the same colleague is reused. Returns false
/// when that rep has no CRM login to grant (Slack-only rep) — they can still be pinged,
/// they just can't open the record.
export async function grantCoverAccess(input: {
  leadId: string;
  coverRepId: string;
  reason: string;
}): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { salesRepId: input.coverRepId },
    select: { id: true, name: true, email: true, salesRep: { select: { slackUserId: true } } },
  });
  if (!user) {
    logger.warn(`Cover access for lead ${input.leadId}: rep ${input.coverRepId} has no linked login`);
    return false;
  }

  const live = await prisma.leadAccessGrant.findFirst({
    where: {
      leadId: input.leadId,
      granteeId: user.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (live) return true;

  const expiresAt = new Date(Date.now() + COVER_GRANT_DAYS * 24 * 60 * 60 * 1000);
  await prisma.leadAccessGrant.create({
    data: { leadId: input.leadId, granteeId: user.id, grantedById: null, reason: input.reason, expiresAt },
  });
  await writeAudit({
    action: "lead.access.grant",
    entityType: "lead",
    entityId: input.leadId,
    newValue: user.name ?? user.email,
    reason: input.reason,
    meta: { granteeId: user.id, expiresAt: expiresAt.toISOString(), system: true, cover: true },
  });
  logger.info(`Cover access to lead ${input.leadId} granted to ${user.email ?? user.id} (${input.reason})`);
  return true;
}

/// Revoke an access grant early. Idempotent (already-revoked is a no-op).
export async function revokeLeadAccess(input: {
  grantId: string;
  actor: { id?: string; email?: string | null };
}): Promise<{ leadId: string }> {
  const grant = await prisma.leadAccessGrant.findUnique({
    where: { id: input.grantId },
    select: { id: true, leadId: true, revokedAt: true, grantee: { select: { name: true, email: true } } },
  });
  if (!grant) throw new OwnershipError("Grant not found");
  if (grant.revokedAt) return { leadId: grant.leadId };

  await prisma.leadAccessGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date(), revokedById: input.actor.id ?? null },
  });
  await writeAudit({
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    action: "lead.access.revoke",
    entityType: "lead",
    entityId: grant.leadId,
    oldValue: grant.grantee.name ?? grant.grantee.email,
  });
  return { leadId: grant.leadId };
}

export type ActiveGrantView = {
  id: string;
  granteeName: string;
  grantedByName: string | null;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
};

/// Active (non-revoked, non-expired) grants on a lead, for the ownership panel.
export async function listActiveGrants(leadId: string): Promise<ActiveGrantView[]> {
  const rows = await prisma.leadAccessGrant.findMany({
    where: { leadId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      reason: true,
      expiresAt: true,
      createdAt: true,
      grantedById: true,
      grantee: { select: { name: true, email: true } },
    },
  });
  // grantedById is a bare User.id (no relation) — resolve the granter names in one query.
  const granterIds = [...new Set(rows.map((r) => r.grantedById).filter((v): v is string => !!v))];
  const granters = granterIds.length
    ? await prisma.user.findMany({ where: { id: { in: granterIds } }, select: { id: true, name: true, email: true } })
    : [];
  const nameOf = (id: string | null) => {
    const g = id ? granters.find((x) => x.id === id) : null;
    return g ? (g.name ?? g.email) : null;
  };

  return rows.map((r) => ({
    id: r.id,
    granteeName: r.grantee.name ?? r.grantee.email,
    grantedByName: nameOf(r.grantedById),
    reason: r.reason,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}
