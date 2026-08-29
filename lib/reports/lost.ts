// Why we lose people (§reports 6) and why we lose quotes (§reports 8).
//
// The two are deliberately separate. A lost LEAD is a person who never got far enough
// to be quoted — a wrong number, a competitor, a price objection raised on the phone. A
// lost QUOTE is a specific treatment at a specific price that somebody said no to, and
// that one carries the pricing signal: if PRP loses on price nine times out of ten, PRP
// is priced wrong, and no amount of lead-level analysis would have told us.

import { prisma } from "@/lib/prisma";
import { within, type DateRange } from "@/lib/reports/range";
import {
  pickTreatmentLabel,
  treatmentKey,
  quoteValue,
  rate,
  median,
  mean,
  sourceLabel,
} from "@/lib/reports/shared";

// ── 6. Lost Lead Analysis ────────────────────────────────────────────

export type LostReasonRow = {
  tag: string;
  count: number;
  sharePct: number | null;
  /// Of the losses with this tag, how many happened before a consultation.
  premature: number;
};

export type LostLeadReport = {
  lost: number;
  /// Leads created in the range, for a loss rate that has a denominator.
  created: number;
  lossRatePct: number | null;
  premature: number;
  prematurePct: number | null;
  byTag: LostReasonRow[];
  bySource: { source: string; label: string; lost: number; created: number; lossRatePct: number | null }[];
  /// How long a lead survives before we lose it.
  medianDaysToLoss: number | null;
  meanDaysToLoss: number | null;
  /// Losses with a written reason and no preset tag — where the unclassified truth is.
  written: { leadId: string; leadName: string; reason: string; lostAt: Date }[];
  /// Marked lost with neither a tag nor a reason. Should be zero; when it isn't, the
  /// rest of this report is missing that much of the picture.
  unexplained: number;
};

export async function lostLeadAnalysis(range: DateRange): Promise<LostLeadReport> {
  const [lost, created, createdBySource] = await Promise.all([
    prisma.lead.findMany({
      where: { lostAt: within(range), deletedAt: null },
      select: {
        id: true,
        name: true,
        source: true,
        lostTag: true,
        lostReason: true,
        lostAt: true,
        prematureLost: true,
        createdAt: true,
      },
      orderBy: { lostAt: "desc" },
    }),
    prisma.lead.count({ where: { createdAt: within(range), deletedAt: null } }),
    prisma.lead.groupBy({
      by: ["source"],
      where: { createdAt: within(range), deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  const total = lost.length;

  const tagCounts = new Map<string, { count: number; premature: number }>();
  for (const l of lost) {
    const tag = l.lostTag?.trim() || (l.lostReason?.trim() ? "Written reason only" : "No reason given");
    const cur = tagCounts.get(tag) ?? { count: 0, premature: 0 };
    cur.count += 1;
    if (l.prematureLost) cur.premature += 1;
    tagCounts.set(tag, cur);
  }

  const createdCount = new Map(
    createdBySource.map((r) => [r.source ?? "unknown", r._count._all]),
  );
  const lostBySource = new Map<string, number>();
  for (const l of lost) {
    const k = l.source ?? "unknown";
    lostBySource.set(k, (lostBySource.get(k) ?? 0) + 1);
  }
  const sources = new Set([...createdCount.keys(), ...lostBySource.keys()]);

  const survival = lost
    .filter((l) => l.lostAt)
    .map((l) => (l.lostAt!.getTime() - l.createdAt.getTime()) / 86_400_000)
    .filter((d) => d >= 0);

  return {
    lost: total,
    created,
    // Both numbers are windowed, so this is "losses recorded per lead received in the
    // same window" — a health indicator, not a cohort outcome.
    lossRatePct: rate(total, created),
    premature: lost.filter((l) => l.prematureLost).length,
    prematurePct: rate(lost.filter((l) => l.prematureLost).length, total),
    byTag: [...tagCounts.entries()]
      .map(([tag, v]) => ({
        tag,
        count: v.count,
        sharePct: rate(v.count, total),
        premature: v.premature,
      }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    bySource: [...sources]
      .map((s) => {
        const c = createdCount.get(s) ?? 0;
        const l = lostBySource.get(s) ?? 0;
        return { source: s, label: sourceLabel(s), lost: l, created: c, lossRatePct: rate(l, c) };
      })
      .sort((a, b) => b.lost - a.lost),
    medianDaysToLoss: median(survival),
    meanDaysToLoss: mean(survival),
    written: lost
      .filter((l) => !l.lostTag && l.lostReason?.trim())
      .slice(0, 15)
      .map((l) => ({
        leadId: l.id,
        leadName: l.name,
        reason: l.lostReason!.trim(),
        lostAt: l.lostAt!,
      })),
    unexplained: lost.filter((l) => !l.lostTag && !l.lostReason?.trim()).length,
  };
}

// ── 8. Lost Quote Analysis 💰 ────────────────────────────────────────

/// A quote can be lost three ways, and they mean different things:
///   • rejected  — somebody said no, and gave a reason from the list.
///   • withdrawn — we pulled it, with a written reason and a name against it.
///   • lapsed    — nobody said anything and the validity ran out. The quiet loss, and
///                 usually the biggest: it's a follow-up failure, not a price problem.
export type LostQuoteRow = {
  key: string;
  treatment: string;
  rejected: number;
  withdrawn: number;
  lapsed: number;
  total: number;
  valueLost: number;
  /// Of this treatment's REJECTIONS, how many were on price. The pricing signal.
  priceRejections: number;
  pricePct: number | null;
  topReason: string | null;
};

export type LostQuoteReport = {
  rejected: number;
  withdrawn: number;
  lapsed: number;
  total: number;
  valueLost: number;
  /// Won in the same window, for a "how often does a quote die" denominator.
  wonInRange: number;
  lossRatePct: number | null;
  byReason: { reason: string; count: number; sharePct: number | null; valueLost: number }[];
  byTreatment: LostQuoteRow[];
  /// Treatments where price is the dominant rejection reason — read this as "we are
  /// probably pricing this wrong", the whole point of the report.
  pricingSignals: { treatment: string; priceRejections: number; rejections: number; pricePct: number }[];
};

/// Minimum rejections before a treatment's price share is worth calling a signal —
/// two out of two is noise, not evidence.
const PRICING_SIGNAL_MIN = 3;
const PRICING_SIGNAL_PCT = 40;

export async function lostQuoteAnalysis(
  range: DateRange,
  now: Date = new Date(),
): Promise<LostQuoteReport> {
  const valueSelect = {
    totalPayable: true,
    price: true,
    invoices: { select: { amount: true } },
  } as const;

  const [closed, lapsed, wonInRange] = await Promise.all([
    // Rejected / withdrawn quotes. There is no closedAt column, so the status change is
    // dated by `updatedAt` — the last write on a closed quote is, in practice, the write
    // that closed it. A quote edited after closing would be dated by that edit instead.
    prisma.quote.findMany({
      where: { status: { in: ["rejected", "withdrawn"] }, updatedAt: within(range) },
      select: {
        id: true,
        treatment: true,
        status: true,
        rejectionReason: true,
        withdrawnReason: true,
        ...valueSelect,
      },
    }),
    // Lapsed: still sitting open, but past its validity. Nothing marks quotes expired
    // automatically, so these would otherwise never appear in any loss count at all.
    // Capped at "now" as well as at the range end — a quote that expires later today
    // hasn't lapsed yet, and counting it would report a loss that hasn't happened.
    prisma.quote.findMany({
      where: {
        status: { in: ["drafted", "sent", "viewed", "accepted", "awaiting_payment", "expired"] },
        expiresAt: {
          gte: range.start,
          lt: new Date(Math.min(range.end.getTime(), now.getTime())),
        },
      },
      select: { id: true, treatment: true, ...valueSelect },
    }),
    prisma.quote.count({ where: { convertedAt: within(range) } }),
  ]);

  const rejected = closed.filter((q) => q.status === "rejected");
  const withdrawn = closed.filter((q) => q.status === "withdrawn");
  const total = closed.length + lapsed.length;
  const valueOf = (rows: { totalPayable: number | null; price: number | null; invoices: { amount: number }[] }[]) =>
    rows.reduce((sum, q) => sum + (quoteValue(q) ?? 0), 0);

  // Reasons: the mandatory list for rejections, plus the two categories that have no
  // list — withdrawals (free text) and lapses (nobody ever said).
  const reasonCounts = new Map<string, { count: number; valueLost: number }>();
  const addReason = (reason: string, value: number) => {
    const cur = reasonCounts.get(reason) ?? { count: 0, valueLost: 0 };
    cur.count += 1;
    cur.valueLost += value;
    reasonCounts.set(reason, cur);
  };
  for (const q of rejected) addReason(q.rejectionReason?.trim() || "No reason recorded", quoteValue(q) ?? 0);
  for (const q of withdrawn) addReason("Withdrawn by clinic", quoteValue(q) ?? 0);
  for (const q of lapsed) addReason("Lapsed — validity expired, no answer", quoteValue(q) ?? 0);

  // Per treatment.
  const byTreatment = new Map<
    string,
    { spellings: string[]; rejected: number; withdrawn: number; lapsed: number; valueLost: number; price: number }
  >();
  const bump = (
    treatment: string,
    kind: "rejected" | "withdrawn" | "lapsed",
    value: number,
    onPrice = false,
  ) => {
    const key = treatmentKey(treatment);
    const cur =
      byTreatment.get(key) ??
      { spellings: [] as string[], rejected: 0, withdrawn: 0, lapsed: 0, valueLost: 0, price: 0 };
    cur.spellings.push(treatment);
    cur[kind] += 1;
    cur.valueLost += value;
    if (onPrice) cur.price += 1;
    byTreatment.set(key, cur);
  };
  for (const q of rejected) {
    bump(q.treatment, "rejected", quoteValue(q) ?? 0, q.rejectionReason?.trim() === "Price too high");
  }
  for (const q of withdrawn) bump(q.treatment, "withdrawn", quoteValue(q) ?? 0);
  for (const q of lapsed) bump(q.treatment, "lapsed", quoteValue(q) ?? 0);

  const rows: LostQuoteRow[] = [...byTreatment.entries()]
    .map(([key, v]) => {
      const t = v.rejected + v.withdrawn + v.lapsed;
      const top =
        v.lapsed >= v.rejected && v.lapsed >= v.withdrawn
          ? "Lapsed"
          : v.rejected >= v.withdrawn
            ? "Rejected"
            : "Withdrawn";
      return {
        key,
        treatment: pickTreatmentLabel(v.spellings),
        rejected: v.rejected,
        withdrawn: v.withdrawn,
        lapsed: v.lapsed,
        total: t,
        valueLost: v.valueLost,
        priceRejections: v.price,
        pricePct: rate(v.price, v.rejected),
        topReason: t > 0 ? top : null,
      };
    })
    .sort((a, b) => b.valueLost - a.valueLost || b.total - a.total);

  const valueLost = valueOf(closed) + valueOf(lapsed);

  return {
    rejected: rejected.length,
    withdrawn: withdrawn.length,
    lapsed: lapsed.length,
    total,
    valueLost,
    wonInRange,
    lossRatePct: rate(total, total + wonInRange),
    byReason: [...reasonCounts.entries()]
      .map(([reason, v]) => ({
        reason,
        count: v.count,
        sharePct: rate(v.count, total),
        valueLost: v.valueLost,
      }))
      .sort((a, b) => b.count - a.count),
    byTreatment: rows,
    pricingSignals: rows
      .filter(
        (r) =>
          r.rejected >= PRICING_SIGNAL_MIN &&
          r.pricePct != null &&
          r.pricePct >= PRICING_SIGNAL_PCT,
      )
      .map((r) => ({
        treatment: r.treatment,
        priceRejections: r.priceRejections,
        rejections: r.rejected,
        pricePct: r.pricePct!,
      }))
      .sort((a, b) => b.pricePct - a.pricePct),
  };
}
