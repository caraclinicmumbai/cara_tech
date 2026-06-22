// Sales pipeline stages (§3.1) — the human-facing lead lifecycle, distinct from
// `status` (the internal automation state). Stage is auto-advanced FORWARD-ONLY
// by call outcomes and freely editable by staff via the dashboard.
//
// Stored as stable snake_case keys; STAGE_LABELS holds the display text.

export const LEAD_STAGES = [
  "fresh_inquiry",
  "communication_not_established",
  "in_consideration",
  "appointment_scheduled",
  "consultation_done",
  "existing_followup",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_LABELS: Record<LeadStage, string> = {
  fresh_inquiry: "Fresh inquiry",
  communication_not_established: "Communication not established",
  in_consideration: "In consideration",
  appointment_scheduled: "Appointment scheduled",
  consultation_done: "Consultation done",
  existing_followup: "Existing + follow up",
};

export const DEFAULT_STAGE: LeadStage = "fresh_inquiry";

export function isLeadStage(v: string): v is LeadStage {
  return (LEAD_STAGES as readonly string[]).includes(v);
}

export function stageLabel(v: string): string {
  return isLeadStage(v) ? STAGE_LABELS[v] : v;
}

// Pipeline order = position in LEAD_STAGES. Used so auto-advance never regresses
// a stage a human (or an earlier, further-along call) already set.
const RANK: Record<LeadStage, number> = Object.fromEntries(
  LEAD_STAGES.map((s, i) => [s, i]),
) as Record<LeadStage, number>;

/// The stage a call outcome implies, or null when it maps to none.
/// (not_interested is handled by the opt-out flag, not a stage; consultation_done
/// and existing_followup are set by staff only.)
export function stageFromOutcome(outcome?: string): LeadStage | null {
  switch (outcome) {
    case "confirmed":
      return "appointment_scheduled";
    case "rescheduled":
      return "in_consideration";
    case "no_answer":
      return "communication_not_established";
    default:
      return null;
  }
}

/// Forward-only auto-advance: returns `next` only if it's further along than the
/// current stage; otherwise null (= leave the stage untouched). Manual edits in
/// the UI bypass this and may move the stage in any direction.
export function advanceStage(current: string, next: LeadStage | null): LeadStage | null {
  if (!next) return null;
  const cur = isLeadStage(current) ? current : DEFAULT_STAGE;
  return RANK[next] > RANK[cur] ? next : null;
}
