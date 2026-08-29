// The money reports (§reports 7, 9, 10) — what we quote, what a person buys alongside
// it, and who comes back.
//
// All three read the QUOTE, never the lead, because that is where treatment and value
// live (§multi-quote: a person doesn't convert, a treatment does). A patient with a
// transplant and a PRP course is one lead and two quotes, and every number here would
// be wrong if it collapsed them into one.

import { prisma } from "@/lib/prisma";
import { within, type DateRange } from "@/lib/reports/range";
import {
  isWon,
  quoteValue,
  pickTreatmentLabel,
  treatmentKey,
  rate,
  mean,
  median,
} from "@/lib/reports/shared";

const QUOTE_VALUE_SELECT = {
  totalPayable: true,
  price: true,
  invoices: { select: { amount: true } },
} as const;

// ── 7. Treatment Mix 💰 ──────────────────────────────────────────────

export type TreatmentMixRow = {
  key: string;
  treatment: string;
  /// Quotes RAISED in the range, and how many of that cohort have converted since.
  quoted: number;
  converted: number;
  conversionPct: number | null;
  /// Still in play — the cohort hasn't finished deciding, which is why a recent range
  /// shows a lower conversion rate than it will eventually earn.
  open: number;
  avgQuoted: number | null;
  avgConverted: number | null;
  /// Revenue from quotes that CONVERTED in the range (not from the cohort above) — the
  /// money that actually landed in the window.
  revenue: number;
  revenueSharePct: number | null;
};

export type TreatmentMixReport = {
  rows: TreatmentMixRow[];
  quoted: number;
  converted: number;
  conversionPct: number | null;
  revenue: number;
  avgQuoteValue: number | null;
  avgConvertedValue: number | null;
  /// Treatments we quote a lot and convert rarely, and the reverse — the two lists a
  /// counsellor's training is built from.
  strongest: TreatmentMixRow[];
  weakest: TreatmentMixRow[];
};

/// Minimum quotes before a conversion rate is worth ranking on.
const MIX_RANK_MIN = 3;

export async function treatmentMix(range: DateRange): Promise<TreatmentMixReport> {
  const [cohort, convertedInRange] = await Promise.all([
    prisma.quote.findMany({
      where: { createdAt: within(range) },
      select: { treatment: true, status: true, ...QUOTE_VALUE_SELECT },
    }),
    prisma.quote.findMany({
      where: { convertedAt: within(range) },
      select: { treatment: true, ...QUOTE_VALUE_SELECT },
    }),
  ]);

  type Acc = {
    spellings: string[];
    quoted: number;
    converted: number;
    open: number;
    quotedValues: number[];
    convertedValues: number[];
    revenue: number;
  };
  const acc = new Map<string, Acc>();
  const get = (treatment: string): Acc => {
    const key = treatmentKey(treatment);
    let cur = acc.get(key);
    if (!cur) {
      cur = { spellings: [], quoted: 0, converted: 0, open: 0, quotedValues: [], convertedValues: [], revenue: 0 };
      acc.set(key, cur);
    }
    cur.spellings.push(treatment);
    return cur;
  };

  for (const q of cohort) {
    const a = get(q.treatment);
    a.quoted += 1;
    const v = quoteValue(q);
    if (v != null) a.quotedValues.push(v);
    if (isWon(q.status)) a.converted += 1;
    else if (!["rejected", "expired", "replaced", "withdrawn"].includes(q.status)) a.open += 1;
  }
  for (const q of convertedInRange) {
    const a = get(q.treatment);
    const v = quoteValue(q);
    if (v != null) {
      a.convertedValues.push(v);
      a.revenue += v;
    }
  }

  const totalRevenue = [...acc.values()].reduce((s, a) => s + a.revenue, 0);

  const rows: TreatmentMixRow[] = [...acc.entries()]
    .map(([key, a]) => ({
      key,
      treatment: pickTreatmentLabel(a.spellings),
      quoted: a.quoted,
      converted: a.converted,
      conversionPct: rate(a.converted, a.quoted),
      open: a.open,
      avgQuoted: mean(a.quotedValues),
      avgConverted: mean(a.convertedValues),
      revenue: a.revenue,
      revenueSharePct: rate(a.revenue, totalRevenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.quoted - a.quoted);

  const rankable = rows.filter((r) => r.quoted >= MIX_RANK_MIN && r.conversionPct != null);
  const allQuoted = cohort.length;
  const allConverted = cohort.filter((q) => isWon(q.status)).length;

  return {
    rows,
    quoted: allQuoted,
    converted: allConverted,
    conversionPct: rate(allConverted, allQuoted),
    revenue: totalRevenue,
    avgQuoteValue: mean(cohort.map((q) => quoteValue(q)).filter((v): v is number => v != null)),
    avgConvertedValue: mean(
      convertedInRange.map((q) => quoteValue(q)).filter((v): v is number => v != null),
    ),
    strongest: [...rankable].sort((a, b) => b.conversionPct! - a.conversionPct!).slice(0, 5),
    weakest: [...rankable].sort((a, b) => a.conversionPct! - b.conversionPct!).slice(0, 5),
  };
}

// ── 9. Multi-Quote Report 💰 ─────────────────────────────────────────

export type TreatmentPair = {
  a: string;
  b: string;
  patients: number;
  revenue: number;
};

export type MultiQuoteReport = {
  /// Patients with at least one converted quote in the range.
  buyers: number;
  /// Of those, how many bought TWO OR MORE different treatments (ever, not just in the
  /// range — the second treatment is what we're looking for, whenever it happened).
  multiBuyers: number;
  multiBuyerPct: number | null;
  /// Patients holding two or more quotes where only one converted — the offer was made
  /// and didn't land. The follow-up list.
  offeredNotTaken: number;
  /// What a patient is worth, single-treatment vs multi-treatment.
  avgSingleValue: number | null;
  avgMultiValue: number | null;
  upliftPct: number | null;
  /// Which treatments actually go together. This is the list counsellors get trained on.
  pairs: TreatmentPair[];
  /// Patients with the most treatments, for the account-management view.
  topPatients: { leadId: string; leadName: string; treatments: string[]; value: number }[];
};

export async function multiQuoteReport(range: DateRange): Promise<MultiQuoteReport> {
  // Everyone who converted something in the window…
  const converted = await prisma.quote.findMany({
    where: { convertedAt: within(range) },
    select: { leadId: true },
  });
  const leadIds = [...new Set(converted.map((q) => q.leadId))];
  if (leadIds.length === 0) {
    return {
      buyers: 0,
      multiBuyers: 0,
      multiBuyerPct: null,
      offeredNotTaken: 0,
      avgSingleValue: null,
      avgMultiValue: null,
      upliftPct: null,
      pairs: [],
      topPatients: [],
    };
  }

  // …then their WHOLE quote history, because the pairing question ("does a transplant
  // lead to PRP?") is about the relationship, not about the window.
  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    select: {
      id: true,
      name: true,
      quotes: { select: { treatment: true, status: true, ...QUOTE_VALUE_SELECT } },
    },
  });

  const pairCounts = new Map<string, TreatmentPair>();
  const singleValues: number[] = [];
  const multiValues: number[] = [];
  let multiBuyers = 0;
  let offeredNotTaken = 0;
  const patients: { leadId: string; leadName: string; treatments: string[]; value: number }[] = [];

  for (const lead of leads) {
    const won = lead.quotes.filter((q) => isWon(q.status));
    // Distinct TREATMENTS, not quotes: a second cycle of the same treatment is the
    // repeat report's business, not this one's.
    const byTreatment = new Map<string, { label: string; value: number }>();
    for (const q of won) {
      const key = treatmentKey(q.treatment);
      const cur = byTreatment.get(key) ?? { label: q.treatment.trim(), value: 0 };
      cur.value += quoteValue(q) ?? 0;
      byTreatment.set(key, cur);
    }
    const treatments = [...byTreatment.entries()];
    const value = treatments.reduce((s, [, v]) => s + v.value, 0);

    if (treatments.length >= 2) {
      multiBuyers += 1;
      multiValues.push(value);
      // Every unordered pair this patient represents.
      const sorted = treatments
        .map(([key, v]) => ({ key, label: v.label }))
        .sort((x, y) => x.key.localeCompare(y.key));
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const id = `${sorted[i].key}|${sorted[j].key}`;
          const cur = pairCounts.get(id) ?? {
            a: sorted[i].label,
            b: sorted[j].label,
            patients: 0,
            revenue: 0,
          };
          cur.patients += 1;
          cur.revenue += value;
          pairCounts.set(id, cur);
        }
      }
      patients.push({ leadId: lead.id, leadName: lead.name, treatments: sorted.map((t) => t.label), value });
    } else if (treatments.length === 1) {
      singleValues.push(value);
      // Quoted more than one treatment but only bought one — the offer was made.
      const quotedTreatments = new Set(lead.quotes.map((q) => treatmentKey(q.treatment)));
      if (quotedTreatments.size >= 2) offeredNotTaken += 1;
    }
  }

  const avgSingle = mean(singleValues);
  const avgMulti = mean(multiValues);

  return {
    buyers: leads.length,
    multiBuyers,
    multiBuyerPct: rate(multiBuyers, leads.length),
    offeredNotTaken,
    avgSingleValue: avgSingle,
    avgMultiValue: avgMulti,
    upliftPct: avgSingle && avgMulti ? ((avgMulti - avgSingle) / avgSingle) * 100 : null,
    pairs: [...pairCounts.values()].sort((a, b) => b.patients - a.patients || b.revenue - a.revenue).slice(0, 15),
    topPatients: patients.sort((a, b) => b.treatments.length - a.treatments.length || b.value - a.value).slice(0, 10),
  };
}

// ── 10. Repeat Treatment Report 💰 ───────────────────────────────────

export type RepeatRow = {
  key: string;
  treatment: string;
  /// Second-or-later cycles of THIS treatment that converted in the range.
  repeats: number;
  /// Distinct patients behind them.
  patients: number;
  revenue: number;
  medianGapMs: number | null;
};

export type RepeatReport = {
  /// Converted quotes in the range that are cycle 2 or later — a patient coming back
  /// for the same treatment (§multi-quote: `cycle` is exactly this count).
  repeats: number;
  repeatPatients: number;
  /// Everyone who converted anything in the range, as the denominator.
  buyers: number;
  repeatRatePct: number | null;
  revenue: number;
  avgValue: number | null;
  /// How long they take to come back, measured from the previous cycle's conversion.
  medianGapMs: number | null;
  meanGapMs: number | null;
  byTreatment: RepeatRow[];
  /// The individual returns, newest first.
  recent: {
    leadId: string;
    leadName: string;
    treatment: string;
    cycle: number;
    value: number | null;
    gapMs: number | null;
    convertedAt: Date;
  }[];
};

export async function repeatTreatment(range: DateRange): Promise<RepeatReport> {
  const [repeatQuotes, buyersInRange] = await Promise.all([
    prisma.quote.findMany({
      where: { convertedAt: within(range), cycle: { gt: 1 } },
      select: {
        leadId: true,
        treatment: true,
        cycle: true,
        convertedAt: true,
        lead: { select: { name: true } },
        ...QUOTE_VALUE_SELECT,
      },
      orderBy: { convertedAt: "desc" },
    }),
    prisma.quote.findMany({
      where: { convertedAt: within(range) },
      select: { leadId: true },
    }),
  ]);

  // The gap is measured against the PREVIOUS cycle of the same treatment for the same
  // patient — which may have converted long before this range, so it's fetched by lead.
  const priorByLead = new Map<string, { treatment: string; cycle: number; convertedAt: Date | null }[]>();
  if (repeatQuotes.length > 0) {
    const priors = await prisma.quote.findMany({
      where: { leadId: { in: [...new Set(repeatQuotes.map((q) => q.leadId))] }, convertedAt: { not: null } },
      select: { leadId: true, treatment: true, cycle: true, convertedAt: true },
    });
    for (const p of priors) {
      const list = priorByLead.get(p.leadId) ?? [];
      list.push(p);
      priorByLead.set(p.leadId, list);
    }
  }

  const gapFor = (q: { leadId: string; treatment: string; cycle: number; convertedAt: Date | null }): number | null => {
    if (!q.convertedAt) return null;
    const key = treatmentKey(q.treatment);
    const prior = (priorByLead.get(q.leadId) ?? [])
      .filter((p) => treatmentKey(p.treatment) === key && p.cycle < q.cycle && p.convertedAt)
      .sort((a, b) => b.cycle - a.cycle)[0];
    if (!prior?.convertedAt) return null;
    const gap = q.convertedAt.getTime() - prior.convertedAt.getTime();
    return gap >= 0 ? gap : null;
  };

  const gaps: number[] = [];
  const byTreatment = new Map<
    string,
    { spellings: string[]; repeats: number; patients: Set<string>; revenue: number; gaps: number[] }
  >();

  const recent = repeatQuotes.map((q) => {
    const gap = gapFor(q);
    if (gap != null) gaps.push(gap);
    const value = quoteValue(q);
    const key = treatmentKey(q.treatment);
    const cur =
      byTreatment.get(key) ??
      { spellings: [] as string[], repeats: 0, patients: new Set<string>(), revenue: 0, gaps: [] as number[] };
    cur.spellings.push(q.treatment);
    cur.repeats += 1;
    cur.patients.add(q.leadId);
    cur.revenue += value ?? 0;
    if (gap != null) cur.gaps.push(gap);
    byTreatment.set(key, cur);

    return {
      leadId: q.leadId,
      leadName: q.lead.name,
      treatment: q.treatment,
      cycle: q.cycle,
      value,
      gapMs: gap,
      convertedAt: q.convertedAt!,
    };
  });

  const repeatPatients = new Set(repeatQuotes.map((q) => q.leadId)).size;
  const buyers = new Set(buyersInRange.map((q) => q.leadId)).size;
  const revenue = repeatQuotes.reduce((s, q) => s + (quoteValue(q) ?? 0), 0);

  return {
    repeats: repeatQuotes.length,
    repeatPatients,
    buyers,
    repeatRatePct: rate(repeatPatients, buyers),
    revenue,
    avgValue: mean(repeatQuotes.map((q) => quoteValue(q)).filter((v): v is number => v != null)),
    medianGapMs: median(gaps),
    meanGapMs: mean(gaps),
    byTreatment: [...byTreatment.entries()]
      .map(([key, v]) => ({
        key,
        treatment: pickTreatmentLabel(v.spellings),
        repeats: v.repeats,
        patients: v.patients.size,
        revenue: v.revenue,
        medianGapMs: median(v.gaps),
      }))
      .sort((a, b) => b.revenue - a.revenue || b.repeats - a.repeats),
    recent: recent.slice(0, 15),
  };
}
