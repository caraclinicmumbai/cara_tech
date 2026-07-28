// Win-Back + Dead-Lead review (Phase 2 §follow-up, "Winning Back Lost Leads").
//
//   • Automatic Win-Back — 90 days after a lead is marked Lost, one warm low-pressure
//     message, MAXIMUM 4 per year, and never if they opted out or consent has expired.
//     Driven by a daily sweep (runWinBackSweep), deduped per lost-event via Lead.lastWinBackAt.
//   • Dead-Lead review queue — leads Lost in the last 30 days, for a Sales/Telecalling Head
//     to approve (singly or in a batch) for one more try (the dead_lead_bulk campaign).
import type { Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enrollLead } from "@/lib/campaigns/engine";
import { campaignsEnabled } from "@/lib/campaigns/types";
import { logger } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/// Max automatic win-backs per lead per rolling year (spec: "maximum 4 a year").
export const WINBACK_MAX_PER_YEAR = 4;

/// Days after a lead is Lost before the automatic win-back fires (spec: 90). Configurable.
export function winBackAfterDays(): number {
  const n = Number(process.env.WINBACK_AFTER_DAYS ?? 90);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

/// How long marketing consent stays valid before it's "expired" for win-back purposes.
/// Default 12 months. A null consent (never captured) is NOT treated as expired.
export function consentMaxAgeDays(): number {
  const n = Number(process.env.WINBACK_CONSENT_MAX_AGE_DAYS ?? 365);
  return Number.isFinite(n) && n > 0 ? n : 365;
}

type ConsentFields = Pick<Lead, "optedOut" | "consentMarketing" | "consentUpdatedAt">;

/// Is the lead eligible on consent grounds for an automatic win-back? (User-approved rule:
/// eligible UNLESS opted out, OR marketing consent explicitly withdrawn, OR consent is stale
/// — consentUpdatedAt older than the window. A null/never-set consent is still eligible.)
export function winBackConsentOk(lead: ConsentFields, now: Date = new Date()): boolean {
  if (lead.optedOut) return false;
  if (lead.consentMarketing === false) return false; // explicitly withdrawn
  if (lead.consentUpdatedAt && lead.consentUpdatedAt.getTime() < now.getTime() - consentMaxAgeDays() * DAY_MS) {
    return false; // stale / expired
  }
  return true;
}

/// How many automatic win-backs this lead has had in the trailing year (the annual cap).
export async function winBackCountThisYear(leadId: string, now: Date = new Date()): Promise<number> {
  return prisma.campaignEnrollment.count({
    where: { leadId, campaignType: "win_back", startedAt: { gte: new Date(now.getTime() - 365 * DAY_MS) } },
  });
}

export type WinBackSweepStats = { scanned: number; enrolled: number; skippedConsent: number; skippedCap: number; skippedOther: number };

/// Daily sweep: enrol eligible Lost leads into the automatic Win-Back campaign. A lead
/// qualifies when it's been Lost for ≥ winBackAfterDays, hasn't already been won-back for
/// THIS lost-event (lastWinBackAt is null or older than lostAt), has no active campaign,
/// passes the consent rule, and is under the annual cap. Marks lastWinBackAt on success so
/// it fires exactly once per lost-event. No-op when the global kill-switch is off.
export async function runWinBackSweep(now: Date = new Date()): Promise<WinBackSweepStats> {
  const stats: WinBackSweepStats = { scanned: 0, enrolled: 0, skippedConsent: 0, skippedCap: 0, skippedOther: 0 };
  if (!campaignsEnabled()) return stats;

  const cutoff = new Date(now.getTime() - winBackAfterDays() * DAY_MS);
  const candidates = await prisma.lead.findMany({
    where: {
      stage: "lost",
      deletedAt: null,
      optedOut: false,
      lostAt: { lte: cutoff },
      // Not yet won-back for this lost-event (or lost again since the last win-back).
      OR: [{ lastWinBackAt: null }, { lastWinBackAt: { lt: prisma.lead.fields.lostAt } }],
      // No campaign currently running for this person.
      campaignEnrollments: { none: { status: "active" } },
    },
    select: { id: true, optedOut: true, consentMarketing: true, consentUpdatedAt: true, lostAt: true, lastWinBackAt: true },
    take: 200,
  });

  for (const lead of candidates) {
    stats.scanned++;
    // Guard the lastWinBackAt < lostAt condition in code too (the field-ref filter above can
    // be finicky across Prisma versions): skip if already won-back at/after this loss.
    if (lead.lastWinBackAt && lead.lostAt && lead.lastWinBackAt.getTime() >= lead.lostAt.getTime()) {
      stats.skippedOther++;
      continue;
    }
    if (!winBackConsentOk(lead, now)) {
      stats.skippedConsent++;
      continue;
    }
    if ((await winBackCountThisYear(lead.id, now)) >= WINBACK_MAX_PER_YEAR) {
      stats.skippedCap++;
      continue;
    }
    const res = await enrollLead(lead.id, "win_back");
    if (res.ok) {
      await prisma.lead.update({ where: { id: lead.id }, data: { lastWinBackAt: now } });
      stats.enrolled++;
    } else {
      stats.skippedOther++;
    }
  }

  if (stats.scanned > 0) logger.info(`Win-back sweep: ${JSON.stringify(stats)}`);
  return stats;
}

export type LostLeadRow = {
  id: string;
  name: string;
  phone: string;
  lostAt: string | null; // ISO
  lostTag: string | null;
  lostReason: string | null;
  repName: string | null;
  lastCqs: number | null;
  inCampaign: boolean; // already has an active campaign (approve disabled)
};

export type LostReviewFilters = { reason?: string; repId?: string };

/// The Dead-Lead review queue: leads marked Lost in the last 30 days, newest first,
/// optionally filtered by lost reason (tag) and by the counsellor who owned them.
export async function listLostForReview(filters: LostReviewFilters = {}, now: Date = new Date()): Promise<LostLeadRow[]> {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const rows = await prisma.lead.findMany({
    where: {
      stage: "lost",
      deletedAt: null,
      lostAt: { gte: since },
      ...(filters.reason ? { lostTag: filters.reason } : {}),
      ...(filters.repId ? { assignedRepId: filters.repId } : {}),
    },
    orderBy: { lostAt: "desc" },
    take: 500,
    select: {
      id: true, name: true, phone: true, lostAt: true, lostTag: true, lostReason: true,
      assignedRep: { select: { name: true } },
      calls: { orderBy: { createdAt: "desc" }, take: 1, select: { cqs: true } },
      campaignEnrollments: { where: { status: "active" }, select: { id: true }, take: 1 },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    lostAt: r.lostAt?.toISOString() ?? null,
    lostTag: r.lostTag,
    lostReason: r.lostReason,
    repName: r.assignedRep?.name ?? null,
    lastCqs: r.calls[0]?.cqs ?? null,
    inCampaign: r.campaignEnrollments.length > 0,
  }));
}
