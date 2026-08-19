// Read model for the Open Quotes desk (§multi-quote). A manager's view of every
// quote still in play — what it's worth, who owns it, what has actually been DONE
// on it, and which ones have gone quiet or are about to expire.
//
// Kept apart from the mutation logic in lib/quotes.ts, the same split as
// lib/postSales/board.ts: pages fetch from here and receive plain serialisable
// objects (dates as ISO strings).
//
// A note on the activity trail: quote actions are audited against the LEAD, with the
// quote identified in `meta.quoteId` (see leads/quoteActions.ts). So the trail is
// fetched by lead and regrouped by quote here rather than queried per quote.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  OPEN_QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  computeQuoteTotals,
  type QuoteStatus,
} from "@/lib/quoteStages";

const DAY_MS = 24 * 60 * 60 * 1000;

/// A quote with no activity for this long is "gone quiet" — the number a manager
/// actually chases. Counted from the last audited action, or from creation if the
/// quote has never been touched since.
export const STALE_AFTER_DAYS = 7;

/// The spec's expiry nudge window (§multi-quote: "nudge 48h before"). Widened to a
/// week for the desk view so a manager sees it coming, not as it happens.
export const EXPIRING_WITHIN_DAYS = 7;

/// What each audited quote action reads as on the desk.
const ACTION_LABELS: Record<string, string> = {
  "lead.quote.create": "raised",
  "lead.quote.revise": "price revised",
  "lead.quote.status": "status moved",
  "lead.quote.owner": "reassigned",
  "lead.quote.unlock": "unlocked",
};

export type QuoteActivity = {
  at: string; // ISO
  action: string; // raw audit action key
  label: string; // human-readable ("price revised")
  actor: string | null; // actor email, null for system/automation
  detail: string | null; // e.g. "sent → viewed", or the revision note
};

export type OpenQuoteRow = {
  id: string;
  leadId: string;
  patientName: string;
  patientPhone: string;
  leadStage: string;
  treatment: string;
  cycle: number;
  status: string;
  statusLabel: string;
  ownerRepId: string | null;
  ownerName: string | null;
  branchName: string | null;
  source: string | null;

  // ── Money, broken out the way the quote itself computes it: discount off the
  //    base first, GST on the discounted amount (lib/quoteStages.computeQuoteTotals). ──
  currency: string;
  base: number;
  discountType: string | null;
  discountValue: number | null;
  discountAmount: number;
  gstRate: number;
  gstAmount: number;
  /// The stored total when the quote has one, else the freshly computed total.
  total: number;

  createdAt: string; // ISO
  ageDays: number;
  expiresAt: string | null; // ISO
  /// Negative once past expiry. Null when the quote has no expiry date.
  daysToExpiry: number | null;
  expired: boolean;
  expiringSoon: boolean;

  // ── Work done / going on ──
  /// Price revisions SINCE the quote was raised. A priced quote is created with an
  /// opening version, so that first row is not a revision and isn't counted.
  revisions: number;
  lastRevisionNote: string | null;
  /// Every audited action on this quote, newest first.
  activity: QuoteActivity[];
  lastActivityAt: string | null; // ISO — null when nothing was ever audited
  daysSinceActivity: number;
  stale: boolean;
  unassigned: boolean;
};

export type OpenQuotesBoard = {
  rows: OpenQuoteRow[];
  /// Rows in scope before the pills narrowed them, and their value — so the page can
  /// say "showing 3 of 27" without a second query.
  scopedCount: number;
  scopedValue: number;
  /// Roll-ups over everything in scope, computed BEFORE the pills filter: the pill
  /// counts stay a fixed target to work down rather than collapsing to the slice
  /// you're currently looking at.
  summary: {
    count: number;
    value: number;
    expiringSoon: number;
    expired: number;
    stale: number;
    unassigned: number;
    /// Open quotes per status, in pipeline order.
    byStatus: { status: QuoteStatus; label: string; count: number; value: number }[];
  };
  owners: { id: string; name: string; count: number }[];
};

export type OpenQuotesFilter = {
  // ── Scope: narrows what the query loads, so the summary reflects it. ──
  /// Lead-visibility scope for the signed-in user (from `leadWhereForUser`).
  leadWhere?: Prisma.LeadWhereInput;
  branchId?: string | null;
  // ── Pills: applied in memory, so the summary and the owner list stay whole. ──
  ownerRepId?: string | null;
  status?: string | null;
  onlyStale?: boolean;
  onlyExpiring?: boolean;
  onlyUnassigned?: boolean;
};

/// One audit row's human-readable detail: a status move reads "sent → viewed"; a
/// revision reads as its rupee change; anything with a reason shows the reason.
function activityDetail(a: {
  action: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
}): string | null {
  if (a.action === "lead.quote.status" && a.oldValue && a.newValue) {
    const from = QUOTE_STATUS_LABELS[a.oldValue as QuoteStatus] ?? a.oldValue;
    const to = QUOTE_STATUS_LABELS[a.newValue as QuoteStatus] ?? a.newValue;
    return `${from} → ${to}${a.reason ? ` · ${a.reason}` : ""}`;
  }
  if (a.action === "lead.quote.revise") {
    const from = a.oldValue ? `₹${Number(a.oldValue).toLocaleString("en-IN")}` : "—";
    const to = a.newValue ? `₹${Number(a.newValue).toLocaleString("en-IN")}` : "—";
    return `${from} → ${to}${a.reason ? ` · ${a.reason}` : ""}`;
  }
  return a.reason ?? null;
}

/// Every quote still in play, with its money, its owner and its activity trail.
/// `now` is injectable so callers (and tests) control the age/staleness clock.
export async function getOpenQuotes(
  filter: OpenQuotesFilter = {},
  now: number = Date.now(),
): Promise<OpenQuotesBoard> {
  const quotes = await prisma.quote.findMany({
    where: {
      status: { in: OPEN_QUOTE_STATUSES },
      // A quote on a trashed lead is not in play.
      lead: { deletedAt: null, ...(filter.leadWhere ?? {}) },
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      leadId: true,
      treatment: true,
      cycle: true,
      status: true,
      price: true,
      currency: true,
      gstRate: true,
      discountType: true,
      discountValue: true,
      totalPayable: true,
      source: true,
      ownerRepId: true,
      expiresAt: true,
      createdAt: true,
      lead: { select: { name: true, phone: true, stage: true } },
      ownerRep: { select: { name: true } },
      branch: { select: { name: true } },
      versions: {
        orderBy: { createdAt: "desc" },
        select: { note: true, createdAt: true },
      },
    },
  });

  // The audit trail for these quotes, fetched by LEAD (that's what it's filed
  // under) and regrouped by `meta.quoteId` below.
  const leadIds = Array.from(new Set(quotes.map((q) => q.leadId)));
  const audits = leadIds.length
    ? await prisma.auditLog.findMany({
        where: { entityType: "lead", entityId: { in: leadIds }, action: { startsWith: "lead.quote." } },
        orderBy: { at: "desc" },
        select: { at: true, action: true, actorEmail: true, oldValue: true, newValue: true, reason: true, meta: true },
      })
    : [];

  const trail = new Map<string, QuoteActivity[]>();
  for (const a of audits) {
    const quoteId = (a.meta as { quoteId?: unknown } | null)?.quoteId;
    if (typeof quoteId !== "string") continue;
    const list = trail.get(quoteId);
    const entry: QuoteActivity = {
      at: a.at.toISOString(),
      action: a.action,
      label: ACTION_LABELS[a.action] ?? a.action.replace("lead.quote.", ""),
      actor: a.actorEmail,
      detail: activityDetail(a),
    };
    if (list) list.push(entry);
    else trail.set(quoteId, [entry]);
  }

  const rows: OpenQuoteRow[] = quotes.map((q) => {
    const totals = computeQuoteTotals({
      base: q.price,
      gstRate: q.gstRate,
      discountType: q.discountType,
      discountValue: q.discountValue,
    });
    const activity = trail.get(q.id) ?? [];
    const lastActivityAt = activity[0]?.at ?? null;
    const sinceMs = now - new Date(lastActivityAt ?? q.createdAt).getTime();
    const daysToExpiry = q.expiresAt
      ? Math.ceil((q.expiresAt.getTime() - now) / DAY_MS)
      : null;

    return {
      id: q.id,
      leadId: q.leadId,
      patientName: q.lead.name,
      patientPhone: q.lead.phone,
      leadStage: q.lead.stage,
      treatment: q.treatment,
      cycle: q.cycle,
      status: q.status,
      statusLabel: QUOTE_STATUS_LABELS[q.status as QuoteStatus] ?? q.status,
      ownerRepId: q.ownerRepId,
      ownerName: q.ownerRep?.name ?? null,
      branchName: q.branch?.name ?? null,
      source: q.source,

      currency: q.currency,
      base: totals.base,
      discountType: totals.discountType,
      discountValue: totals.discountValue,
      discountAmount: totals.discountAmount,
      gstRate: totals.gstRate,
      gstAmount: totals.gstAmount,
      total: q.totalPayable ?? totals.total,

      createdAt: q.createdAt.toISOString(),
      ageDays: Math.max(0, Math.floor((now - q.createdAt.getTime()) / DAY_MS)),
      expiresAt: q.expiresAt?.toISOString() ?? null,
      daysToExpiry,
      expired: daysToExpiry != null && daysToExpiry < 0,
      expiringSoon: daysToExpiry != null && daysToExpiry >= 0 && daysToExpiry <= EXPIRING_WITHIN_DAYS,

      revisions: Math.max(0, q.versions.length - 1),
      lastRevisionNote: q.versions.find((v) => v.note)?.note ?? null,
      activity,
      lastActivityAt,
      daysSinceActivity: Math.max(0, Math.floor(sinceMs / DAY_MS)),
      stale: sinceMs >= STALE_AFTER_DAYS * DAY_MS,
      unassigned: !q.ownerRepId,
    };
  });

  const summary = {
    count: rows.length,
    value: rows.reduce((sum, r) => sum + r.total, 0),
    expiringSoon: rows.filter((r) => r.expiringSoon).length,
    expired: rows.filter((r) => r.expired).length,
    stale: rows.filter((r) => r.stale).length,
    unassigned: rows.filter((r) => r.unassigned).length,
    byStatus: OPEN_QUOTE_STATUSES.map((s) => {
      const inStatus = rows.filter((r) => r.status === s);
      return {
        status: s,
        label: QUOTE_STATUS_LABELS[s],
        count: inStatus.length,
        value: inStatus.reduce((sum, r) => sum + r.total, 0),
      };
    }),
  };

  // Owner roll-up for the filter bar — every rep holding at least one open quote.
  const byOwner = new Map<string, { id: string; name: string; count: number }>();
  for (const r of rows) {
    if (!r.ownerRepId) continue;
    const cur = byOwner.get(r.ownerRepId);
    if (cur) cur.count += 1;
    else byOwner.set(r.ownerRepId, { id: r.ownerRepId, name: r.ownerName ?? "—", count: 1 });
  }

  // The pills narrow the visible rows only. Everything above — the summary and the
  // owner list — keeps counting the whole scope, so switching from one owner to
  // another doesn't first require clearing the filter that hid them.
  const visible = rows.filter(
    (r) =>
      (!filter.ownerRepId || r.ownerRepId === filter.ownerRepId) &&
      (!filter.status || r.status === filter.status) &&
      (!filter.onlyStale || r.stale) &&
      (!filter.onlyExpiring || r.expiringSoon || r.expired) &&
      (!filter.onlyUnassigned || r.unassigned),
  );

  return {
    rows: visible,
    scopedCount: rows.length,
    scopedValue: summary.value,
    summary,
    owners: Array.from(byOwner.values()).sort((a, b) => b.count - a.count),
  };
}
