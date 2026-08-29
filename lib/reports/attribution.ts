// Source Attribution (§reports 5) — cost per lead, per consultation, per surgery.
//
// Two rules shape this report:
//
//  1. **Attribution follows the person's door, once.** A lead's `source` is where they
//     came from; every consultation and every converted quote for that person is
//     credited to that source. A quote raised later in a consultation is still owed to
//     the ad that brought them in — the clinic paid once for the relationship.
//
//  2. **A missing cost is "unavailable", not zero.** Cost columns are withheld for any
//     source whose spend isn't imported for every day of the range (see lib/adSpend.ts).
//     Understating cost is the one error that would make this report actively harmful:
//     it makes a channel look cheap and moves budget toward it.

import { prisma } from "@/lib/prisma";
import { spendCoverage, lastImportedDay, type SourceSpend } from "@/lib/adSpend";
import { within, type DateRange } from "@/lib/reports/range";
import {
  PAID_SOURCES,
  bookedConsultation,
  isWon,
  quoteValue,
  rate,
  sourceLabel,
} from "@/lib/reports/shared";

export type AttributionRow = {
  source: string;
  label: string;
  paid: boolean;
  leads: number;
  consultations: number;
  /// Converted quotes belonging to those leads — "surgeries" in the clinic's words.
  /// A patient who converts two treatments is two surgeries, which is what cost-per-
  /// surgery should divide by: the clinic performs (and is paid for) each one.
  surgeries: number;
  /// Distinct PATIENTS who had at least one surgery. The rate below uses this rather
  /// than the surgery count — otherwise one patient taking two treatments produces a
  /// "200% conversion rate", which is arithmetically true and useless.
  patientsWithSurgery: number;
  revenue: number;
  leadToConsultPct: number | null;
  consultToSurgeryPct: number | null;
  /// Spend + coverage. `spend` is null for an unpaid source (nothing to spend) and for
  /// a paid source with no import at all.
  spend: number | null;
  spendComplete: boolean;
  daysMissing: number;
  /// Null whenever cost can't be stated honestly — either no spend data, or an
  /// incomplete range. The page renders these as "unavailable", never as ₹0.
  costPerLead: number | null;
  costPerConsultation: number | null;
  costPerSurgery: number | null;
  /// Return on ad spend, revenue ÷ spend. Same withholding rules.
  roas: number | null;
};

export type AttributionReport = {
  rows: AttributionRow[];
  totals: {
    leads: number;
    consultations: number;
    surgeries: number;
    revenue: number;
    spend: number | null;
  };
  /// True when no ad spend has ever been imported — the report explains how instead of
  /// implying the channels were free.
  noSpendData: boolean;
  lastImportedDay: string | null;
  /// Paid sources whose spend is missing days in this range.
  incompleteSources: { source: string; label: string; daysMissing: number }[];
};

export async function sourceAttribution(range: DateRange): Promise<AttributionReport> {
  const [leads, coverage, lastImport] = await Promise.all([
    prisma.lead.findMany({
      where: { createdAt: within(range), deletedAt: null },
      select: {
        id: true,
        source: true,
        stage: true,
        quotes: {
          select: {
            status: true,
            totalPayable: true,
            price: true,
            invoices: { select: { amount: true } },
          },
        },
      },
    }),
    spendCoverage(range),
    lastImportedDay(),
  ]);

  // Group the leads acquired in this range by the door they came through. Their quotes
  // are counted whenever they converted — a lead from last week whose surgery is booked
  // today still belongs to last week's ad.
  type Group = {
    leads: number;
    consultations: number;
    surgeries: number;
    patientsWithSurgery: number;
    revenue: number;
  };
  const blank = (): Group => ({
    leads: 0,
    consultations: 0,
    surgeries: 0,
    patientsWithSurgery: 0,
    revenue: 0,
  });

  const groups = new Map<string, Group>();
  for (const l of leads) {
    const key = l.source ?? "unknown";
    const g = groups.get(key) ?? blank();
    g.leads += 1;
    let hadSurgery = false;
    for (const q of l.quotes) {
      if (!isWon(q.status)) continue;
      g.surgeries += 1;
      hadSurgery = true;
      g.revenue += quoteValue(q) ?? 0;
    }
    if (hadSurgery) g.patientsWithSurgery += 1;
    if (bookedConsultation(l.stage, hadSurgery)) g.consultations += 1;
    groups.set(key, g);
  }

  // Every paid source appears even at zero leads: a channel we spent on and got nothing
  // from is the single most important row on this table.
  for (const s of PAID_SOURCES) {
    if (!groups.has(s)) groups.set(s, blank());
  }

  const rows: AttributionRow[] = [...groups.entries()].map(([source, g]) => {
    const paid = PAID_SOURCES.includes(source);
    const cov: SourceSpend | undefined = coverage.bySource.get(source);
    const usable = paid && !!cov && cov.complete;
    const spend = paid && cov && cov.daysCovered > 0 ? cov.amount : null;

    const per = (n: number) => (usable && n > 0 ? cov!.amount / n : null);

    return {
      source,
      label: sourceLabel(source),
      paid,
      leads: g.leads,
      consultations: g.consultations,
      surgeries: g.surgeries,
      patientsWithSurgery: g.patientsWithSurgery,
      revenue: g.revenue,
      leadToConsultPct: rate(g.consultations, g.leads),
      consultToSurgeryPct: rate(g.patientsWithSurgery, g.consultations),
      spend,
      spendComplete: !!cov?.complete,
      daysMissing: cov?.daysMissing.length ?? 0,
      costPerLead: per(g.leads),
      costPerConsultation: per(g.consultations),
      costPerSurgery: per(g.surgeries),
      roas: usable && cov!.amount > 0 ? g.revenue / cov!.amount : null,
    };
  });

  rows.sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));

  const sum = (pick: (r: AttributionRow) => number) => rows.reduce((a, r) => a + pick(r), 0);

  return {
    rows,
    totals: {
      leads: sum((r) => r.leads),
      consultations: sum((r) => r.consultations),
      surgeries: sum((r) => r.surgeries),
      revenue: sum((r) => r.revenue),
      // A total spend is only stated when every paid source is fully covered; a partial
      // total is the same lie as a missing day counted as zero.
      spend: coverage.allComplete ? coverage.total : null,
    },
    noSpendData: coverage.empty,
    lastImportedDay: lastImport,
    incompleteSources: PAID_SOURCES.map((s) => coverage.bySource.get(s)!)
      .filter((c) => c.daysMissing.length > 0)
      .map((c) => ({
        source: c.source,
        label: sourceLabel(c.source),
        daysMissing: c.daysMissing.length,
      })),
  };
}
