// IST wall-clock arithmetic for scheduling (§3.2). Branch hours and doctor rosters
// are wall-clock facts ("Andheri opens at 10"), appointments are instants. These
// helpers convert between the two. IST has no DST, so a fixed +05:30 is exact.
import { istDateKey } from "@/lib/datetime";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
export const MINUTE_MS = 60_000;

/// The instant at `minutes` past IST midnight on the IST date `dateKey` ("YYYY-MM-DD").
export function istInstant(dateKey: string, minutes: number): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS + minutes * MINUTE_MS);
}

/// Minutes past IST midnight for an instant (0..1439).
export function istMinutes(d: Date): number {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/// IST weekday, 0 = Sunday … 6 = Saturday.
export function istWeekday(d: Date): number {
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCDay();
}

/// Weekday of an IST date key.
export function weekdayOfKey(dateKey: string): number {
  return istWeekday(istInstant(dateKey, 12 * 60));
}

/// A @db.Date column value (UTC midnight of the calendar date) for an IST date key.
export function dateColumn(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

/// The IST date key stored in a @db.Date column.
export function keyOfDateColumn(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export { istDateKey };

/// "HH:MM" ↔ minutes, for the setup forms.
export function minutesToHhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function hhmmToMinutes(v: string): number | null {
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

/// Half-open interval overlap: [a1,a2) and [b1,b2) share at least one instant.
export function overlaps(a1: Date, a2: Date, b1: Date, b2: Date): boolean {
  return a1 < b2 && b1 < a2;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
