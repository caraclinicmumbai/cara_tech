// Numbers behind the overview dashboard (§dashboard).
//
// Every figure on that screen is "this month vs last", so the queries come in
// pairs and the deltas are computed here rather than in the page — a percentage
// that is wrong is worse than one that is missing, and there is exactly one
// place to check it.
//
// Month boundaries are IST calendar months. The clinic's day starts and ends in
// Mumbai, and a UTC month boundary would file the evening of the 31st under the
// following month, quietly misstating both.
import { prisma } from "@/lib/prisma";

const IST_OFFSET_MIN = 330;
const DAY_MS = 86_400_000;

/// Start of the IST month containing `now`, as a real (UTC) instant.
export function istMonthStart(now: Date = new Date(), monthsBack = 0): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const shifted = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - monthsBack, 1);
  return new Date(shifted - IST_OFFSET_MIN * 60_000);
}

/// Start of an IST day, `daysBack` days ago.
export function istDayStart(now: Date = new Date(), daysBack = 0): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(midnight - daysBack * DAY_MS - IST_OFFSET_MIN * 60_000);
}

export type Delta = {
  /// Percent change against the previous period, or null when the previous
  /// period was zero — "up from nothing" has no honest percentage.
  pct: number | null;
  direction: "up" | "down" | "flat";
};

export function delta(current: number, previous: number): Delta {
  if (previous === 0) return { pct: null, direction: current > 0 ? "up" : "flat" };
  const pct = ((current - previous) / previous) * 100;
  return { pct, direction: pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat" };
}

export type StatFigure = {
  label: string;
  value: string;
  delta: Delta;
  /// Where the tile's corner arrow goes — every number should be openable.
  href: string;
  /// True when a rise is bad news (an unreachable lead is not an achievement).
  inverse?: boolean;
};

export type DashboardData = {
  stats: StatFigure[];
  /// Leads per IST day, oldest first, for the column chart.
  daily: { day: string; label: string; value: number }[];
  /// Lead sources, largest first, tail already folded into "Other".
  sources: { label: string; value: number }[];
  totalLeadsThisMonth: number;
  awaitingFirstCall: number;
  awaitingHandover: number;
  monthLabel: string;
};

const SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
  walk_in: "Walk-in",
  whatsapp: "WhatsApp",
};

/// A donut is only readable at a glance with a handful of segments, so the tail
/// past the top four is summed into "Other" rather than drawn as four more
/// near-identical slices.
const DONUT_SEGMENTS = 4;

/// How many days the column chart covers.
const DAILY_DAYS = 8;

export async function getDashboardData(now: Date = new Date()): Promise<DashboardData> {
  const thisMonth = istMonthStart(now, 0);
  const lastMonth = istMonthStart(now, 1);
  const windowStart = istDayStart(now, DAILY_DAYS - 1);

  const live = { deletedAt: null };

  const [
    leadsThis,
    leadsLast,
    callsThis,
    callsLast,
    confirmedThis,
    confirmedLast,
    noAnswerThis,
    noAnswerLast,
    lostThis,
    lostLast,
    awaitingFirstCall,
    awaitingHandover,
    bySource,
    dailyRows,
  ] = await Promise.all([
    prisma.lead.count({ where: { ...live, createdAt: { gte: thisMonth } } }),
    prisma.lead.count({ where: { ...live, createdAt: { gte: lastMonth, lt: thisMonth } } }),
    prisma.call.count({ where: { createdAt: { gte: thisMonth } } }),
    prisma.call.count({ where: { createdAt: { gte: lastMonth, lt: thisMonth } } }),
    prisma.lead.count({ where: { ...live, status: "confirmed", updatedAt: { gte: thisMonth } } }),
    prisma.lead.count({
      where: { ...live, status: "confirmed", updatedAt: { gte: lastMonth, lt: thisMonth } },
    }),
    prisma.call.count({ where: { outcome: "no_answer", createdAt: { gte: thisMonth } } }),
    prisma.call.count({
      where: { outcome: "no_answer", createdAt: { gte: lastMonth, lt: thisMonth } },
    }),
    prisma.lead.count({ where: { ...live, stage: "lost", lostAt: { gte: thisMonth } } }),
    prisma.lead.count({ where: { ...live, stage: "lost", lostAt: { gte: lastMonth, lt: thisMonth } } }),
    // The two operational queues the desk actually works from.
    prisma.lead.count({ where: { ...live, status: "new", calls: { none: {} } } }),
    prisma.lead.count({ where: { ...live, needsHandover: true } }),
    prisma.lead.groupBy({ by: ["source"], where: live, _count: { _all: true } }),
    prisma.lead.findMany({
      where: { ...live, createdAt: { gte: windowStart } },
      select: { createdAt: true },
    }),
  ]);

  const reachThis = callsThis ? ((callsThis - noAnswerThis) / callsThis) * 100 : 0;
  const reachLast = callsLast ? ((callsLast - noAnswerLast) / callsLast) * 100 : 0;

  const stats: StatFigure[] = [
    {
      label: "New leads",
      value: String(leadsThis),
      delta: delta(leadsThis, leadsLast),
      href: "/leads",
    },
    {
      label: "Calls made",
      value: String(callsThis),
      delta: delta(callsThis, callsLast),
      href: "/calls",
    },
    {
      label: "Confirmed",
      value: String(confirmedThis),
      delta: delta(confirmedThis, confirmedLast),
      href: "/leads",
    },
    {
      label: "Reach rate",
      value: `${reachThis.toFixed(0)}%`,
      delta: delta(Math.round(reachThis), Math.round(reachLast)),
      href: "/calls",
    },
    {
      label: "Lost",
      value: String(lostThis),
      delta: delta(lostThis, lostLast),
      href: "/leads",
      // More lost leads is not growth, so the tone of the pill flips.
      inverse: true,
    },
  ];

  // Bucket the window's leads by IST day. Done in memory over one indexed read
  // rather than eight COUNT queries.
  const buckets = new Map<string, number>();
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    buckets.set(istDayKeyOf(istDayStart(now, i)), 0);
  }
  for (const row of dailyRows) {
    const key = istDayKeyOf(row.createdAt);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const daily = [...buckets.entries()].map(([day, value]) => ({
    day,
    label: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
    }).format(new Date(`${day}T06:00:00Z`)),
    value,
  }));

  const ranked = bySource
    .map((r) => ({
      label: r.source ? (SOURCE_LABELS[r.source] ?? r.source) : "Unknown",
      value: r._count._all,
    }))
    .sort((a, b) => b.value - a.value);
  const head = ranked.slice(0, DONUT_SEGMENTS);
  const tail = ranked.slice(DONUT_SEGMENTS);
  const sources = tail.length
    ? [...head, { label: "Other", value: tail.reduce((n, r) => n + r.value, 0) }]
    : head;

  return {
    stats,
    daily,
    sources,
    totalLeadsThisMonth: leadsThis,
    awaitingFirstCall,
    awaitingHandover,
    monthLabel: new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      month: "long",
      year: "numeric",
    }).format(now),
  };
}

function istDayKeyOf(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
