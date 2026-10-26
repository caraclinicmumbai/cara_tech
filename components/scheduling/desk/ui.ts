// Shared vocabulary for the appointments desk: status colours (the tag palette — one
// hue per status, each with its own fill/line/ink), IST formatters, view keys.

export const STATUS_TONE: Record<string, string> = {
  tentative: "ink",
  booked: "blue",
  confirmed: "klein",
  checked_in: "citric",
  in_progress: "tangerine",
  completed: "aqua",
  no_show: "fushia",
  cancelled: "neutral",
  rescheduled: "neutral",
};

export const STATUS_LABEL: Record<string, string> = {
  tentative: "Held",
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_progress: "In progress",
  completed: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
  rescheduled: "Rescheduled",
};

/// The verb on the button that moves an appointment INTO a status.
export const STATUS_ACTION: Record<string, string> = {
  booked: "Mark unconfirmed",
  confirmed: "Confirm",
  checked_in: "Check in",
  in_progress: "Start",
  completed: "Complete",
  no_show: "No-show",
  cancelled: "Cancel",
};

export const VIEWS = [
  { key: "resources", label: "Day · columns" },
  { key: "list", label: "Day · list" },
  { key: "week", label: "Week" },
  { key: "board", label: "Front desk board" },
  { key: "find", label: "Find a slot" },
] as const;
export type ViewKey = (typeof VIEWS)[number]["key"];

const TZ = "Asia/Kolkata";
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const longDayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));
export const fmtDay = (dateKey: string) => dayFmt.format(new Date(`${dateKey}T12:00:00+05:30`));
export const fmtLongDay = (dateKey: string) => longDayFmt.format(new Date(`${dateKey}T12:00:00+05:30`));
export const fmtRange = (a: string, b: string) => `${fmtTime(a)} – ${fmtTime(b)}`;

export function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/// The IST date key of an instant.
export function keyOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
}

/// IST date key + n days.
export function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

/// Monday of the IST week containing dateKey.
export function weekStart(dateKey: string): string {
  const wd = new Date(`${dateKey}T12:00:00+05:30`).getUTCDay(); // 0 Sun
  return addDays(dateKey, wd === 0 ? -6 : 1 - wd);
}

/// Minutes past IST midnight for an ISO instant.
export function istMin(iso: string): number {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/// The instant for an IST date key + minutes, as ISO.
export function istIso(dateKey: string, minutes: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 330 * 60_000 + minutes * 60_000).toISOString();
}
