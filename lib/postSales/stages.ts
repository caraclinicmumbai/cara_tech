// Post-sales journey stages (§post-sales). The CLINICAL track — deliberately
// separate from the two tracks that already exist:
//
//   Lead.stage    — the PERSON's sales track (lib/leadStages.ts)
//   Quote.status  — the TREATMENT's commercial track (lib/quoteStages.ts)
//   here          — the TREATMENT's clinical track, one per converted quote
//
// A patient who converts a hair transplant and a PRP course has TWO journeys on
// this track, moving at their own speeds. The journey opens at `converted` (an
// invoice exists) and ends at `closed_successfully`.
//
// Pure constants + pure functions only — this module is imported by client
// components, so it must never reach for Prisma or the environment.

/// The six stages, in order. `converted` is the entry stage: the journey opens
/// there the moment billing confirms an invoice for that quote.
///
/// The spec's alternative path (Consultation Done → Converted → …) is the LEAD's
/// route into conversion, not an extra journey stage — "Consultation Done" lives
/// on Lead.stage. Both routes land here at `converted`.
export const JOURNEY_STAGES = [
  "converted",
  "pre_op",
  "surgery_done",
  "post_op_followup",
  "recovery_monitoring",
  "closed_successfully",
] as const;

export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export const JOURNEY_STAGE_LABELS: Record<JourneyStage, string> = {
  converted: "Converted",
  pre_op: "Pre-Op Preparation",
  surgery_done: "Surgery Done",
  post_op_followup: "Post-Op Follow-Up",
  recovery_monitoring: "Recovery Monitoring",
  closed_successfully: "Closed Successfully",
};

/// One line on what the team is actually meant to do in each stage — rendered as
/// help text on the journey page so a new consultant doesn't have to ask.
export const JOURNEY_STAGE_HINTS: Record<JourneyStage, string> = {
  converted: "Invoice raised. Hand over to the clinical team and assign a consultant.",
  pre_op: "Pre-op instructions, tests, consents and the surgery slot confirmed.",
  surgery_done: "Procedure complete — record the surgery date to start the check-in schedule.",
  post_op_followup: "Immediate recovery: day-1 and day-7 check-ins, dressing and medication review.",
  recovery_monitoring: "Longer arc: day-30 and day-90 check-ins, growth/outcome review.",
  closed_successfully: "Outcome achieved and signed off. Nothing further is scheduled.",
};

export const FIRST_JOURNEY_STAGE: JourneyStage = "converted";
export const TERMINAL_JOURNEY_STAGE: JourneyStage = "closed_successfully";

/// The stage whose entry records the surgery date and generates the check-ins.
export const SURGERY_STAGE: JourneyStage = "surgery_done";

export function isJourneyStage(v: string | null | undefined): v is JourneyStage {
  return !!v && (JOURNEY_STAGES as readonly string[]).includes(v);
}

/// 0-based position of a stage in the journey, or -1 for an unknown key.
export function journeyStageIndex(stage: string): number {
  return (JOURNEY_STAGES as readonly string[]).indexOf(stage);
}

/// Is `to` a step BACKWARD from `from`? Backward moves are allowed (a surgery gets
/// postponed, a stage was advanced by mistake) but only with a written reason, so
/// the clinical trail explains itself. See lib/postSales/journeys.ts.
export function isBackwardMove(from: string, to: string): boolean {
  const a = journeyStageIndex(from);
  const b = journeyStageIndex(to);
  return a >= 0 && b >= 0 && b < a;
}

/// A journey is "live" until it reaches the terminal stage — live journeys are what
/// the board shows by default and what the overdue sweep looks at.
export function isJourneyLive(stage: string): boolean {
  return stage !== TERMINAL_JOURNEY_STAGE;
}

// ── Check-ins (§post-sales) ──────────────────────────────────────────

/// The standard post-surgery check-in schedule, in days after surgery. A treatment
/// may override this via TreatmentStagePolicy.checkInDays.
export const DEFAULT_CHECKIN_DAYS = [1, 7, 30, 90] as const;

/// Check-in row statuses. `blocked` is the important one: it means the system could
/// NOT send automatically (no approved template, a safety flag, clinical consent
/// withheld) and a human has to make the call — so it surfaces as a task rather
/// than vanishing.
export const CHECKIN_STATUSES = [
  "pending",
  "sent",
  "done_manually",
  "skipped",
  "blocked",
  "failed",
] as const;

export type CheckInStatus = (typeof CHECKIN_STATUSES)[number];

export const CHECKIN_STATUS_LABELS: Record<CheckInStatus, string> = {
  pending: "Scheduled",
  sent: "Sent",
  done_manually: "Done by hand",
  skipped: "Skipped",
  blocked: "Needs a person",
  failed: "Failed",
};

/// A check-in still to happen — what the tick picks up and what the board counts.
export function isCheckInOpen(status: string): boolean {
  return status === "pending" || status === "failed";
}
