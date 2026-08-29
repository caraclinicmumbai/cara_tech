// The reporting date range (§reports) — one implementation, because every report on
// the page must be answering about the *same* window or the numbers can't be compared
// across tabs.
//
// The clinic thinks in IST calendar days and Postgres stores UTC instants, so a range
// is: [IST midnight on `from`, IST midnight on the day AFTER `to`). Doing this the naive
// way (`new Date("2026-08-30")`) yields UTC midnight, which is 05:30 IST — so everything
// a clinic did between 00:00 and 05:30 lands in the previous day's bucket, and every
// daily count is quietly wrong. Hence the explicit offset arithmetic below.

const IST_OFFSET_MIN = 5 * 60 + 30; // +05:30, no DST
const IST_OFFSET_MS = IST_OFFSET_MIN * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/// The IST calendar day of an instant, as "YYYY-MM-DD".
export function istDay(d: Date | number): string {
  const t = typeof d === "number" ? d : d.getTime();
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/// The UTC instant at which an IST calendar day ("YYYY-MM-DD") begins. This is the
/// canonical way a day is stored on AdSpend and compared against createdAt.
export function istDayStart(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) - IST_OFFSET_MS);
}

/// Today's IST calendar day.
export function istToday(now: Date = new Date()): string {
  return istDay(now);
}

/// Shift an IST day key by n days (negative to go back).
export function addDays(day: string, n: number): string {
  return istDay(istDayStart(day).getTime() + n * DAY_MS);
}

/// Every IST day key from `from` to `to` inclusive, in order. Capped so a fat-fingered
/// range can't render a million table rows.
export function daysBetween(from: string, to: string, cap = 400): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to && out.length < cap) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/// The presets offered above every report. `custom` is what the two date inputs produce.
export const RANGE_PRESETS = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "365d", label: "Last 12 months", days: 365 },
] as const;

export type RangePresetKey = (typeof RANGE_PRESETS)[number]["key"];

export const DEFAULT_PRESET: RangePresetKey = "30d";

export type DateRange = {
  /// Inclusive IST day keys, as the date inputs and URL speak them.
  fromDay: string;
  toDay: string;
  /// The half-open UTC instants to query with: `{ gte: start, lt: end }`.
  start: Date;
  end: Date;
  /// Number of IST days covered (inclusive of both ends).
  days: number;
  /// Which preset produced this, or null when the dates were typed by hand.
  preset: RangePresetKey | null;
  /// Human label for the header, e.g. "1 Aug – 30 Aug 2026".
  label: string;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function labelFor(fromDay: string, toDay: string): string {
  const fmt = (day: string, withYear: boolean) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    }).format(istDayStart(day));
  if (fromDay === toDay) return fmt(fromDay, true);
  const sameYear = fromDay.slice(0, 4) === toDay.slice(0, 4);
  return `${fmt(fromDay, !sameYear)} – ${fmt(toDay, true)}`;
}

/// Build the range from the URL's search params. Anything malformed falls back to the
/// default preset rather than erroring — a report page should always render something.
export function resolveRange(
  params: { preset?: string; from?: string; to?: string } = {},
  now: Date = new Date(),
): DateRange {
  const today = istToday(now);

  let fromDay: string;
  let toDay: string;
  let preset: RangePresetKey | null = null;

  const custom = DAY_RE.test(params.from ?? "") && DAY_RE.test(params.to ?? "");
  if (custom) {
    // Tolerate a backwards range rather than showing nothing.
    const a = params.from!;
    const b = params.to!;
    fromDay = a <= b ? a : b;
    toDay = a <= b ? b : a;
  } else {
    const chosen =
      RANGE_PRESETS.find((p) => p.key === params.preset) ??
      RANGE_PRESETS.find((p) => p.key === DEFAULT_PRESET)!;
    preset = chosen.key;
    toDay = today;
    fromDay = addDays(today, -(chosen.days - 1));
  }

  const start = istDayStart(fromDay);
  const end = istDayStart(addDays(toDay, 1)); // half-open: up to but not including
  return {
    fromDay,
    toDay,
    start,
    end,
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS),
    preset,
    label: labelFor(fromDay, toDay),
  };
}

/// The same-length window immediately before this one — for "vs previous period".
export function previousRange(range: DateRange): DateRange {
  const toDay = addDays(range.fromDay, -1);
  const fromDay = addDays(toDay, -(range.days - 1));
  const start = istDayStart(fromDay);
  const end = istDayStart(addDays(toDay, 1));
  return {
    fromDay,
    toDay,
    start,
    end,
    days: range.days,
    preset: null,
    label: labelFor(fromDay, toDay),
  };
}

/// The Prisma filter for a timestamp column falling inside the range.
export function within(range: DateRange): { gte: Date; lt: Date } {
  return { gte: range.start, lt: range.end };
}
