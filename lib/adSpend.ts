// Ad spend — the cost side of Source Attribution (§reports 5).
//
// Nothing in the CRM knows what an ad cost; it has to be imported from the platforms
// (scripts/importAdSpend.ts, or POST /api/webhooks/ad-spend). Which makes the central
// rule of this module: **a day nobody imported is "unavailable", never zero.**
//
// The distinction is load-bearing. If a missing Tuesday counted as ₹0, every
// cost-per-lead in the report would read lower than the truth and the cheapest-looking
// channel would be whichever one we forgot to import. So:
//   • A day with genuinely no spend must be imported as an explicit **0** row.
//   • A day with no row at all is a hole, and any cost figure covering it is withheld.
import { prisma } from "@/lib/prisma";
import { daysBetween, istDay, istDayStart, within, type DateRange } from "@/lib/reports/range";
import { PAID_SOURCES } from "@/lib/reports/shared";

export class AdSpendError extends Error {}

export type AdSpendInput = {
  /// IST calendar day, "YYYY-MM-DD".
  day: string;
  source: string;
  /// Platform campaign id/name; empty = the source's daily total.
  campaign?: string | null;
  amount: number;
  currency?: string;
  branchId?: string | null;
  importedFrom?: string;
  note?: string | null;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/// Record one day's spend. Re-importing REPLACES the row rather than adding to it —
/// the platforms restate spend for a day or two after the fact, and the last word from
/// the platform is the one we want.
export async function recordAdSpend(input: AdSpendInput): Promise<{ id: string; replaced: boolean }> {
  if (!DAY_RE.test(input.day)) throw new AdSpendError(`Day must be YYYY-MM-DD, got "${input.day}"`);
  const source = input.source?.trim().toLowerCase();
  if (!source) throw new AdSpendError("A source is required");
  if (!PAID_SOURCES.includes(source)) {
    throw new AdSpendError(
      `"${source}" isn't a paid source. Spend belongs to one of: ${PAID_SOURCES.join(", ")}.`,
    );
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new AdSpendError("Amount must be zero or more (a day with no spend is an explicit 0)");
  }

  const day = istDayStart(input.day);
  const campaign = (input.campaign ?? "").trim();
  const existing = await prisma.adSpend.findUnique({
    where: { day_source_campaign: { day, source, campaign } },
    select: { id: true },
  });

  const data = {
    amount: Math.round(input.amount),
    currency: input.currency?.trim().toUpperCase() || "INR",
    branchId: input.branchId ?? null,
    importedFrom: input.importedFrom?.trim() || "csv",
    note: input.note ?? null,
  };

  const row = await prisma.adSpend.upsert({
    where: { day_source_campaign: { day, source, campaign } },
    create: { day, source, campaign, ...data },
    update: data,
    select: { id: true },
  });
  return { id: row.id, replaced: !!existing };
}

export type SourceSpend = {
  source: string;
  /// Total imported spend across the range, in whole rupees.
  amount: number;
  /// IST days in the range that have at least one row for this source.
  daysCovered: number;
  /// Days with no row at all — the reason a cost figure may be withheld.
  daysMissing: string[];
  /// True when every day in the range is accounted for. Only then is cost-per-X real.
  complete: boolean;
};

export type SpendCoverage = {
  /// Keyed by lead source (facebook | instagram | google).
  bySource: Map<string, SourceSpend>;
  /// Sum across sources — only meaningful when `allComplete`.
  total: number;
  /// Every paid source fully covered for every day of the range.
  allComplete: boolean;
  /// True when there is no spend data at all — the report says "import it" rather than
  /// implying the data is patchy.
  empty: boolean;
  rangeDays: number;
};

/// Spend for a range, together with how much of the range it actually covers.
export async function spendCoverage(range: DateRange): Promise<SpendCoverage> {
  const rows = await prisma.adSpend.findMany({
    where: { day: within(range) },
    select: { day: true, source: true, amount: true },
  });

  const allDays = daysBetween(range.fromDay, range.toDay);
  const bySource = new Map<string, SourceSpend>();

  for (const source of PAID_SOURCES) {
    const mine = rows.filter((r) => r.source === source);
    const covered = new Set(mine.map((r) => istDay(r.day)));
    const missing = allDays.filter((d) => !covered.has(d));
    bySource.set(source, {
      source,
      amount: mine.reduce((sum, r) => sum + r.amount, 0),
      daysCovered: covered.size,
      daysMissing: missing,
      // A source nobody has ever imported is not "complete with zero spend".
      complete: covered.size > 0 && missing.length === 0,
    });
  }

  // Spend imported against a source we don't recognise still counts toward the total,
  // so the total never understates what was spent.
  const known = new Set(PAID_SOURCES);
  const strayTotal = rows.filter((r) => !known.has(r.source)).reduce((s, r) => s + r.amount, 0);

  return {
    bySource,
    total: rows.reduce((sum, r) => sum + r.amount, 0),
    allComplete: PAID_SOURCES.every((s) => bySource.get(s)!.complete),
    empty: rows.length === 0 && strayTotal === 0,
    rangeDays: allDays.length,
  };
}

/// The most recent day any spend was imported for — shown on the report so a stale
/// import is visible rather than silently deflating every cost figure.
export async function lastImportedDay(): Promise<string | null> {
  const row = await prisma.adSpend.findFirst({ orderBy: { day: "desc" }, select: { day: true } });
  return row ? istDay(row.day) : null;
}
