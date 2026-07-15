// Quote lifecycle (Phase 2 §multi-quote) — the treatment-track, distinct from the
// lead's person-track in lib/leadStages.ts. A lead is the person; a quote is the
// treatment. Each quote moves through its own status independently, and once
// converted runs its own post-sales journey. Stored as stable snake_case keys.

/// A quote's commercial status. `converted` requires a real invoice (billing
/// tells us). Terminal-but-not-won: rejected | expired | replaced | withdrawn.
export const QUOTE_STATUSES = [
  "drafted",
  "sent",
  "viewed",
  "accepted",
  "awaiting_payment",
  "converted",
  "in_treatment",
  "completed",
  "rejected",
  "expired",
  "replaced",
  "withdrawn",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  drafted: "Drafted",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  awaiting_payment: "Awaiting Payment",
  converted: "Converted",
  in_treatment: "In Treatment",
  completed: "Completed",
  rejected: "Rejected",
  expired: "Expired",
  replaced: "Replaced",
  withdrawn: "Withdrawn",
};

export const DEFAULT_QUOTE_STATUS: QuoteStatus = "drafted";

/// A quote is "open" (blocks a second open quote for the same treatment, §multi-quote)
/// until it reaches a closed state. A new cycle can only start once it's closed.
export const OPEN_QUOTE_STATUSES: QuoteStatus[] = [
  "drafted",
  "sent",
  "viewed",
  "accepted",
  "awaiting_payment",
];

/// Won = the quote produced value (converted and beyond). Used where "did this
/// person convert anything?" matters — e.g. the lead's stuck-stage SLA skips a lead
/// that already has a won quote.
export const WON_QUOTE_STATUSES: QuoteStatus[] = ["converted", "in_treatment", "completed"];

/// Closed = won OR a terminal non-won state. New-cycle gate + reporting.
export const CLOSED_QUOTE_STATUSES: QuoteStatus[] = [
  ...WON_QUOTE_STATUSES,
  "rejected",
  "expired",
  "replaced",
  "withdrawn",
];

export function isQuoteStatus(v: string): v is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(v);
}

export function isQuoteOpen(status: string): boolean {
  return (OPEN_QUOTE_STATUSES as readonly string[]).includes(status);
}

/// Once a quote converts it LOCKS (read-only). Never locks the lead — the person may
/// still be working other open quotes (§multi-quote: the single most likely bug).
export function isQuoteLocked(status: string): boolean {
  return status === "converted" || status === "in_treatment" || status === "completed";
}

// ── Post-sales journey (§post-sales) — one journey per CONVERTED quote. A patient
//    who converts two treatments has two journeys, possibly at different speeds. ──

export const QUOTE_JOURNEY_STAGES = [
  "pre_op",
  "surgery_done",
  "post_op_followup",
  "recovery_monitoring",
  "closed_successfully",
] as const;

export type QuoteJourneyStage = (typeof QUOTE_JOURNEY_STAGES)[number];

export const QUOTE_JOURNEY_LABELS: Record<QuoteJourneyStage, string> = {
  pre_op: "Pre-Op Preparation",
  surgery_done: "Surgery Done",
  post_op_followup: "Post-Op Follow-Up",
  recovery_monitoring: "Recovery Monitoring",
  closed_successfully: "Closed Successfully",
};

/// What brought a quote about — attribution stops at the door the patient walked
/// through for THIS treatment, it doesn't follow them around (§multi-quote source).
export const QUOTE_SOURCES = [
  "ad",
  "asked_during_consultation",
  "post_op_upsell",
  "existing_patient_repeat",
] as const;

export type QuoteSource = (typeof QUOTE_SOURCES)[number];

export const QUOTE_SOURCE_LABELS: Record<QuoteSource, string> = {
  ad: "Ad / Original Enquiry",
  asked_during_consultation: "Asked During Consultation",
  post_op_upsell: "Post-Op Upsell",
  existing_patient_repeat: "Existing Patient — Repeat",
};

/// Mandatory rejection reasons (§multi-quote: rejection reason required, from a list).
export const QUOTE_REJECTION_REASONS = [
  "Price too high",
  "Chose competitor",
  "Decided against treatment",
  "Medical ineligibility",
  "Went silent",
  "Other",
] as const;

/// Default quote validity before it expires (§multi-quote: default 30 days).
export const QUOTE_DEFAULT_VALIDITY_DAYS = 30;
