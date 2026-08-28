// Timestamp formatting for the UI. The clinic operates in IST and the servers run
// in UTC, so ALL user-facing times must be rendered in Asia/Kolkata explicitly —
// otherwise `toLocaleString()` picks up the server's UTC and reads 5h30m early.
// Works in both RSC (Node) and client components (browser) via Intl + timeZone.

const IST_DATETIME: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
};

/// Format a date/time in IST, e.g. "4 Jul 2026, 10:02 AM IST".
export function formatIst(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", IST_DATETIME).format(date) + " IST";
}

const IST_DATE: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
};

/// Format a date in IST (date only), e.g. "4 Jul 2026". For compact table columns.
export function formatIstDate(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", IST_DATE).format(date);
}

/// The IST calendar day as "YYYY-MM-DD" — the value an `<input type="date">` speaks.
/// Comparing formatted labels would break the moment the format changes, and comparing
/// UTC days puts anything after 6:30pm IST on the wrong date.
export function istDateKey(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  // en-CA renders ISO-ordered dates, so this is a formatter away from what we want.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
