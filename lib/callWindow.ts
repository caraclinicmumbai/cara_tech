// Do-Not-Call window (§3.1.2). The AI must not place automated calls during the
// configured night window (default 22:00–10:00 IST). Leads/retries that would
// fire inside it are pushed to the next window opening (10:00 IST) and released
// in FIFO order by the worker.
//
// All times are computed in IST (Asia/Kolkata) regardless of server timezone —
// Railway runs UTC — per the spec's "all timestamps in IST" rule. IST is a fixed
// UTC+5:30 (India has no DST), so the conversion is constant.

const TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 5 * 60 + 30; // +05:30

// Calls are permitted in [PERMITTED_START_HOUR, PERMITTED_END_HOUR) IST.
// Defaults: allowed 10:00–22:00 → DND 22:00–10:00.
const PERMITTED_START_HOUR = Number(process.env.DND_END_HOUR ?? 10);
const PERMITTED_END_HOUR = Number(process.env.DND_START_HOUR ?? 22);

function istParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: v("year"), month: v("month"), day: v("day"), hour: v("hour") };
}

/// True if `d` falls inside the do-not-call window (default 22:00–10:00 IST).
export function isWithinDnd(d: Date = new Date()): boolean {
  const { hour } = istParts(d);
  return hour < PERMITTED_START_HOUR || hour >= PERMITTED_END_HOUR;
}

/// The next instant at which calling is permitted. Returns `d` unchanged if it's
/// already in the permitted window; otherwise the upcoming permitted-start
/// (e.g. 10:00 IST today if it's early morning, or tomorrow if it's late night).
export function nextPermittedTime(d: Date = new Date()): Date {
  const { year, month, day, hour } = istParts(d);
  if (hour >= PERMITTED_START_HOUR && hour < PERMITTED_END_HOUR) return d;

  let y = year,
    m = month,
    dd = day;
  if (hour >= PERMITTED_END_HOUR) {
    // Late night → roll to tomorrow's permitted-start (UTC arithmetic avoids TZ drift).
    const t = new Date(Date.UTC(year, month - 1, day));
    t.setUTCDate(t.getUTCDate() + 1);
    y = t.getUTCFullYear();
    m = t.getUTCMonth() + 1;
    dd = t.getUTCDate();
  }
  // Build the IST wall-clock permitted-start as a UTC instant (IST = UTC + 5:30).
  const utcMs = Date.UTC(y, m - 1, dd, PERMITTED_START_HOUR, 0) - IST_OFFSET_MIN * 60_000;
  return new Date(utcMs);
}

/// Delay (ms from `now`) for a call that should fire after `baseDelayMs`, but
/// never inside the DND window — if it lands there, push to the next opening.
export function permittedDelayMs(now: Date, baseDelayMs: number): number {
  const target = nextPermittedTime(new Date(now.getTime() + baseDelayMs));
  return Math.max(0, target.getTime() - now.getTime());
}
