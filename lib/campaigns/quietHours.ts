// Per-branch marketing quiet hours (Phase 2 §follow-up). Automated campaign messages
// must NEVER go out inside a branch's quiet window (default 20:00–09:00 IST). This is
// SEPARATE from the AI-call do-not-call window (lib/callWindow.ts): that governs voice
// calls (22:00–10:00), this governs campaign messages, and each branch can set its own.
//
// Like callWindow, all arithmetic is done in IST (Asia/Kolkata) regardless of server
// timezone — Railway runs UTC. IST is a fixed UTC+5:30 (no DST), so the offset is constant.

const TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 5 * 60 + 30; // +05:30

/// Defaults when a branch (or the whole install) hasn't set quiet hours: 20:00–09:00 IST.
export const DEFAULT_QUIET_START = 20; // 8 PM
export const DEFAULT_QUIET_END = 9; // 9 AM

export type QuietWindow = { start: number; end: number };

/// Resolve a branch's quiet window, falling back to the defaults for any null/out-of-range
/// value. `start`/`end` are IST wall-clock hours [0-23]; start===end means "no quiet hours".
export function resolveQuietWindow(
  quietStartHour?: number | null,
  quietEndHour?: number | null,
): QuietWindow {
  const valid = (h: number | null | undefined, fallback: number) =>
    typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23 ? h : fallback;
  return {
    start: valid(quietStartHour, DEFAULT_QUIET_START),
    end: valid(quietEndHour, DEFAULT_QUIET_END),
  };
}

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

/// True if `d` (IST) falls inside the quiet window. Handles a window that wraps midnight
/// (start > end, e.g. 20→09) as well as a same-day window (start < end). start===end = never.
export function isWithinQuietHours(w: QuietWindow, d: Date = new Date()): boolean {
  if (w.start === w.end) return false;
  const { hour } = istParts(d);
  return w.start > w.end
    ? hour >= w.start || hour < w.end // wraps midnight
    : hour >= w.start && hour < w.end; // same day
}

/// The next instant at or after `d` at which messaging is permitted (i.e. the upcoming
/// window END). Returns `d` unchanged when it's already outside the quiet window.
export function nextAfterQuietHours(w: QuietWindow, d: Date = new Date()): Date {
  if (!isWithinQuietHours(w, d)) return d;
  const { year, month, day, hour } = istParts(d);
  let y = year,
    m = month,
    dd = day;
  // If we're in the pre-midnight part of a wrapping window (hour >= start >= end), the
  // window closes at `end` TOMORROW. Otherwise (early-morning part, or a same-day window)
  // it closes at `end` today.
  const closesTomorrow = w.start > w.end && hour >= w.start;
  if (closesTomorrow) {
    const t = new Date(Date.UTC(year, month - 1, day));
    t.setUTCDate(t.getUTCDate() + 1);
    y = t.getUTCFullYear();
    m = t.getUTCMonth() + 1;
    dd = t.getUTCDate();
  }
  // Build the IST wall-clock window-end as a UTC instant (IST = UTC + 5:30).
  const utcMs = Date.UTC(y, m - 1, dd, w.end, 0) - IST_OFFSET_MIN * 60_000;
  return new Date(utcMs);
}
