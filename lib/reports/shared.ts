// Shared vocabulary for the report set (§reports). Every report imports its
// definitions from here so that "reached", "converted", "consultation" and "what a
// quote is worth" mean exactly one thing across ten tabs — a report set whose tabs
// disagree with each other is worse than no report set.

import { WON_QUOTE_STATUSES } from "@/lib/quoteStages";
import { stageRank } from "@/lib/leadStages";

/// Call types the AI places (excludes human_handover and the two inbound kinds).
/// Mirrors lib/digest.ts so the daily Slack digest and this report can't drift.
export const AI_CALL_TYPES = ["initial", "reconfirmation"];

/// Outcomes that mean the AI actually REACHED a human and got a decision. "no_answer"
/// is the only outcome that isn't a contact; a null outcome is a call that never got
/// written back, which we count as attempted-but-unknown rather than reached.
export const REACHED_OUTCOMES = ["confirmed", "rescheduled", "not_interested"];

/// Lead sources we pay for. Only these get cost-per-lead maths; a referral or a walk-in
/// has no ad cost, and printing "₹0 per lead" against them would read as free rather
/// than as unpriced.
export const PAID_SOURCES = ["facebook", "instagram", "google"];

export const LEAD_SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
  walk_in: "Walk-in",
  whatsapp: "WhatsApp",
  inbound_call: "Inbound call",
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown";
  return LEAD_SOURCE_LABELS[source] ?? source;
}

/// Normalise a treatment name so "Hair Transplant", "hair transplant " and
/// "Hair  Transplant" are one row in a report rather than three. Same rule as the
/// one-open-quote-per-treatment check in lib/quotes.ts.
export function treatmentKey(treatment: string): string {
  return treatment.trim().toLowerCase().replace(/\s+/g, " ");
}

/// A display name for a normalised treatment key — the most common spelling actually
/// used, so the report reads in the clinic's own words rather than in lower case.
export function pickTreatmentLabel(spellings: string[]): string {
  const counts = new Map<string, number>();
  for (const s of spellings) {
    const t = s.trim();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best = "";
  let bestN = -1;
  for (const [t, n] of counts) {
    if (n > bestN || (n === bestN && t < best)) {
      best = t;
      bestN = n;
    }
  }
  return best || "—";
}

/// Did this quote produce value? Converted and beyond (§multi-quote).
export function isWon(status: string): boolean {
  return (WON_QUOTE_STATUSES as readonly string[]).includes(status);
}

/// A lead has reached the consultation stage — used as "consultation booked" across the
/// counsellor and attribution reports. Stage is FORWARD-ONLY, so a lead now sitting at
/// consultation_done necessarily passed through appointment_scheduled; comparing rank
/// rather than equality is what makes that count.
///
/// Caveat worth knowing when reading these numbers: `stage` is the lead's CURRENT
/// position, not an event log. A lead who booked and was later marked Lost reads as
/// lost, not as a consultation. There is no appointment record to count instead until
/// the calendar work lands (see docs/deferred-todo.md).
const APPOINTMENT_RANK = stageRank("appointment_scheduled");
const CONSULTED_RANK = stageRank("consultation_done");

/// Has this lead reached a consultation? Two ways of knowing, and both are needed:
///
///  • the stage says so, or
///  • they bought something — you cannot have a treatment without being consulted.
///
/// The second clause isn't a nicety. Stage is maintained by hand and the lead track
/// deliberately ends at `consultation_done` (conversion lives on the quote), so a
/// patient who converted while their stage still read "in consideration" would
/// otherwise be counted as a surgery with no consultation behind it — which produced
/// "200% consult-to-surgery" rates in testing. Passing `hasWonQuote` keeps the
/// denominator at least as large as the numerator, which is what makes it a rate.
export function bookedConsultation(stage: string, hasWonQuote = false): boolean {
  if (hasWonQuote) return true;
  const r = stageRank(stage);
  return r >= APPOINTMENT_RANK && stage !== "lost";
}

export function didConsultation(stage: string, hasWonQuote = false): boolean {
  if (hasWonQuote) return true;
  const r = stageRank(stage);
  return r >= CONSULTED_RANK && stage !== "lost";
}

/// What a quote is WORTH, in whole rupees. An invoice is the fact — it's what the
/// patient was actually billed — so it wins wherever one exists; `totalPayable` (the
/// quoted figure including GST, less discount) is the estimate we fall back to.
/// Returns null when there is no price at all, which reports must render as "—" rather
/// than as zero.
export function quoteValue(quote: {
  totalPayable: number | null;
  price: number | null;
  invoices?: { amount: number }[];
}): number | null {
  const invoiced = quote.invoices?.reduce((sum, i) => sum + i.amount, 0) ?? 0;
  if (invoiced > 0) return invoiced;
  if (quote.totalPayable != null) return quote.totalPayable;
  return quote.price;
}

// ── Presentation helpers ─────────────────────────────────────────────
// These return strings for the page, and are deliberately strict about the difference
// between "zero" and "we don't know": every one of them renders null as an em dash.

/// Rupees, Indian digit grouping. Null → "—".
export function inr(n: number | null | undefined): string {
  return n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/// Rupees, abbreviated for tiles: ₹1.2L, ₹3.4Cr.
export function inrShort(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1e3) return `₹${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `₹${Math.round(n)}`;
}

/// A rate as a percentage, or null when the denominator is zero — "0%" and "nothing to
/// divide by" are different findings and must not look the same.
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function pct(n: number | null | undefined, digits = 0): string {
  return n == null ? "—" : `${n.toFixed(digits)}%`;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/// The middle value. Reported alongside the mean for anything time-based, because one
/// counsellor on holiday for a week drags an average somewhere no real handover went.
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/// A duration in milliseconds, phrased the way someone reads a response time.
export function duration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)} days`;
}

/// Days, for "how long until they came back".
export function days(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const d = ms / 86_400_000;
  if (d < 1) return "same day";
  return `${d.toFixed(d < 10 ? 1 : 0)} days`;
}
