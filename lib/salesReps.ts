// Sales rep roster + round-robin assignment (§3.1). Handovers are distributed
// to the least-recently-assigned active rep, so load spreads evenly across the
// team. Assignment is recorded on both the rep (cursor) and the lead.
import type { Prisma, SalesRep } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { OPEN_QUOTE_STATUSES } from "@/lib/quoteStages";
import { logger } from "@/lib/logger";

/// Who can be GIVEN a lead — by the rota, a handover, or a quote-owner pick: an active,
/// non-sales-head rep on the roster WITH A LOGIN. The login is the point. A rep record is
/// just a name and a phone number, and one added "to be set up later" used to go straight
/// to the front of the rota (never assigned → sorts first) and collect leads that nobody
/// could ever open. A rep without a login can't see a single lead, so they can't own one.
export const ASSIGNABLE_REP: Prisma.SalesRepWhereInput = {
  active: true,
  salesHead: false,
  deletedAt: null,
  user: { isNot: null },
};

/// The telecallers' rota: assignable reps whose login is a Telecaller / Counsellor. A
/// first-time caller to the clinic line rings only these — branch managers and other roles
/// that happen to carry a rep record are in the general rota, but not on the phones.
export const TELECALLER_REP: Prisma.SalesRepWhereInput = {
  ...ASSIGNABLE_REP,
  user: { is: { role: "telecaller" } },
};

const ROTA_ORDER = [
  { lastAssignedAt: { sort: "asc" as const, nulls: "first" as const } },
  { createdAt: "asc" as const },
];

/// The next telecaller to ring for a first-time caller: available, not already on a call,
/// and not one of `exclude` (already rung on this call). Advances the round-robin cursor, so
/// the next new caller starts with the next person.
/// `includeOffline` widens it to Offline telecallers too (see isReachable in
/// lib/inboundRouting.ts for when that's allowed). Break and In-Consultation never qualify.
export async function pickNextTelecaller(
  exclude: string[] = [],
  opts: { includeOffline?: boolean } = {},
): Promise<SalesRep | null> {
  const rep = await prisma.salesRep.findFirst({
    where: {
      ...TELECALLER_REP,
      availability: opts.includeOffline ? { in: ["available", "offline"] } : "available",
      onCall: false,
      ...(exclude.length ? { id: { notIn: exclude } } : {}),
    },
    orderBy: ROTA_ORDER,
  });
  if (!rep) return null;
  await prisma.salesRep.update({ where: { id: rep.id }, data: { lastAssignedAt: new Date() } });
  return rep;
}

/// Give an UNOWNED lead to `repId` — the telecaller who just answered its first call — and
/// hand them the lead's unowned follow-up steps with it. A lead that already has an owner is
/// left alone: one conditional update, so two callbacks for the same answer can't both claim.
/// Returns true when this call made the assignment.
export async function claimUnownedLead(leadId: string, repId: string, reason: string): Promise<boolean> {
  const rep = await prisma.salesRep.findUnique({ where: { id: repId }, select: { name: true } });
  const claimed = await prisma.lead.updateMany({
    where: { id: leadId, assignedRepId: null },
    data: { assignedRepId: repId, assignedAt: new Date() },
  });
  if (claimed.count === 0) return false;
  await prisma.leadFollowUpStep.updateMany({
    where: { leadId, ownerKind: "rep", ownerRepId: null, status: "pending" },
    data: { ownerRepId: repId },
  });
  await writeAudit({
    action: "lead.assign", entityType: "lead", entityId: leadId,
    oldValue: "Unassigned", newValue: rep?.name ?? repId,
    reason,
    meta: { repId, system: true },
  });
  logger.info(`Lead ${leadId} claimed by rep ${repId} (${reason})`);
  return true;
}

/// Pick the next rep round-robin (least-recently-assigned AVAILABLE rep) and advance
/// the cursor. Sales heads are excluded — they're managers, not the rota. Only reps
/// whose availability is "available" are eligible (§presence): in-consultation, on
/// break, and offline counsellors are skipped so new leads never land with someone
/// who's stepped away. Returns null when no eligible reps are free.
export async function pickNextRep(): Promise<SalesRep | null> {
  const rep = await prisma.salesRep.findFirst({
    where: { ...ASSIGNABLE_REP, availability: "available" },
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
  opts: { preferAvailable?: boolean; pool?: Prisma.SalesRepWhereInput } = {},
): Promise<SalesRep | null> {
  const base = opts.pool ?? ASSIGNABLE_REP;
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
  const base: Prisma.SalesRepWhereInput = {
    ...ASSIGNABLE_REP,
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
  return prisma.salesRep.findFirst({ where: { active: true, salesHead: true, deletedAt: null } });
}

/// The rep who owns a lead (assigned at intake / handover), or null.
export async function getLeadOwner(leadId: string): Promise<SalesRep | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedRep: true },
  });
  return lead?.assignedRep ?? null;
}

/// Assign a lead to a rep (records who + when on the lead). Audited so the ownership trail
/// is complete alongside manual handovers: as a system assignment (no human actor, "assigned
/// automatically") for the round-robin, or with the actor and reason when a person caused it
/// — the creator of a lead becoming its owner.
export async function assignLeadToRep(
  leadId: string,
  repId: string,
  opts: { reason?: string; actor?: { id?: string; email?: string | null } } = {},
): Promise<void> {
  const before = await prisma.lead.findUnique({ where: { id: leadId }, select: { assignedRep: { select: { name: true } } } });
  const rep = await prisma.salesRep.findUnique({ where: { id: repId }, select: { name: true } });
  await prisma.lead.update({
    where: { id: leadId },
    data: { assignedRepId: repId, assignedAt: new Date() },
  });
  await writeAudit({
    action: "lead.assign", entityType: "lead", entityId: leadId,
    oldValue: before?.assignedRep?.name ?? "Unassigned", newValue: rep?.name ?? repId,
    actorId: opts.actor?.id, actorEmail: opts.actor?.email,
    reason: opts.reason ?? "Assigned automatically",
    meta: { repId, system: !opts.actor },
  });
  logger.info(`Lead ${leadId} assigned to rep ${repId}`);
}

/// Is this rep someone a lead can be given to right now (see ASSIGNABLE_REP)?
export async function isAssignableRep(repId: string): Promise<boolean> {
  return (await prisma.salesRep.count({ where: { ...ASSIGNABLE_REP, id: repId } })) > 0;
}

/// Remove a rep from the roster, handing everything they were responsible for to `toRepId`
/// first: the leads they own, their open quotes, and their pending follow-up steps. Then the
/// rep is soft-deleted (`deletedAt`) and unlinked from any login.
///
/// Soft, because the rep is history as well as a roster entry: past calls (`handledBy`) and
/// audit entries name them, and a hard delete would null every one of those — the record of
/// who spoke to a patient would read "—". The receiving rep must be assignable, which is
/// what stops the leads of a rep with no login being moved to another one.
///
/// The moves and the removal are one transaction, so a failure leaves nothing half-moved.
/// Each lead's move is then audited as a handover, the same entry a manual one writes.
export async function removeRep(input: {
  repId: string;
  toRepId: string;
  actor: { id?: string; email?: string | null };
}): Promise<{ leads: number; quotes: number; followUps: number }> {
  if (input.repId === input.toRepId) throw new Error("Pick a different counsellor to receive the leads");
  const rep = await prisma.salesRep.findUnique({
    where: { id: input.repId },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!rep || rep.deletedAt) throw new Error("That rep has already been removed");
  const toRep = await prisma.salesRep.findFirst({
    where: { ...ASSIGNABLE_REP, id: input.toRepId },
    select: { id: true, name: true },
  });
  if (!toRep) throw new Error("The receiving counsellor must be active and have a login");

  // For the per-lead audit below; the move itself matches on the owner, inside the transaction.
  const leadIds = (
    await prisma.lead.findMany({ where: { assignedRepId: rep.id }, select: { id: true } })
  ).map((l) => l.id);

  const [, quotes, followUps] = await prisma.$transaction([
    prisma.lead.updateMany({
      where: { assignedRepId: rep.id },
      data: { assignedRepId: toRep.id, assignedAt: new Date() },
    }),
    prisma.quote.updateMany({
      where: { ownerRepId: rep.id, status: { in: [...OPEN_QUOTE_STATUSES] } },
      data: { ownerRepId: toRep.id },
    }),
    prisma.leadFollowUpStep.updateMany({
      where: { ownerRepId: rep.id, status: "pending" },
      data: { ownerRepId: toRep.id },
    }),
    prisma.user.updateMany({ where: { salesRepId: rep.id }, data: { salesRepId: null } }),
    prisma.salesRep.update({
      where: { id: rep.id },
      data: { active: false, deletedAt: new Date(), onCall: false, availability: "offline" },
    }),
  ]);

  for (const leadId of leadIds) {
    await writeAudit({
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      action: "lead.handover",
      entityType: "lead",
      entityId: leadId,
      oldValue: rep.name,
      newValue: toRep.name,
      reason: `${rep.name} was removed from the roster`,
      meta: { toRepId: toRep.id, fromRepId: rep.id, repRemoved: true },
    });
  }
  await writeAudit({
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    action: "rep.remove",
    entityType: "rep",
    entityId: rep.id,
    oldValue: rep.name,
    newValue: `Work handed to ${toRep.name}`,
    meta: { toRepId: toRep.id, leads: leadIds.length, quotes: quotes.count, followUps: followUps.count },
  });
  logger.info(
    `Rep ${rep.id} (${rep.name}) removed by ${input.actor.email ?? "?"}: ` +
      `${leadIds.length} leads, ${quotes.count} quotes, ${followUps.count} follow-ups → ${toRep.name}`,
  );
  return { leads: leadIds.length, quotes: quotes.count, followUps: followUps.count };
}
