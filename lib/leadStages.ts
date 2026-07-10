// Sales pipeline stages (§3.1) — the human-facing lead lifecycle, distinct from
// `status` (the internal automation state). Stage is auto-advanced FORWARD-ONLY
// by call outcomes/events and freely editable by staff via the dashboard.
//
// Stored as stable snake_case keys; STAGE_LABELS holds the display text.

export const LEAD_STAGES = [
  "ai_contacted",
  "ai_attempted_unreachable",
  "communication_not_established",
  "human_callback_pending",
  "in_consideration",
  "appointment_scheduled",
  "consultation_done",
  "converted",
  "lost",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_LABELS: Record<LeadStage, string> = {
  ai_contacted: "AI Contacted",
  ai_attempted_unreachable: "AI Attempted — Unreachable",
  communication_not_established: "Communication Not Established",
  human_callback_pending: "Human Callback Pending",
  in_consideration: "In Consideration",
  appointment_scheduled: "Appointment Scheduled",
  consultation_done: "Consultation Done",
  converted: "Converted",
  lost: "Lost",
};

/// "Lost" needs a preset tag and/or a written reason (see LOST_PRESET_TAGS).
export const LOST_STAGE: LeadStage = "lost";

/// A new lead enters the pipeline in the AI-contact phase.
export const DEFAULT_STAGE: LeadStage = "ai_contacted";

/// Preset reasons shown when marking a lead Lost. A tag makes the free-text review
/// optional; picking none requires a written reason instead.
export const LOST_PRESET_TAGS = [
  "Not interested",
  "Enquired for different product",
  "Wrong number",
  "Pricing issue",
  "Enquired for competitor",
  "Did not enquire",
  "Chose competitor",
  "Location issue",
  "Clinic staff",
  "Nonsense",
  "Other",
] as const;

export type LostTag = (typeof LOST_PRESET_TAGS)[number];

export function isLostTag(v: string): v is LostTag {
  return (LOST_PRESET_TAGS as readonly string[]).includes(v);
}

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

/// The stage a call outcome implies on its own, or null when it maps to none.
/// (Handover → human_callback_pending and unreachable-after-retries →
/// ai_attempted_unreachable are decided in recordCall, which has that context;
/// not_interested is opt-out only and doesn't move the stage.)
export function stageFromOutcome(outcome?: string): LeadStage | null {
  switch (outcome) {
    case "confirmed":
      return "appointment_scheduled";
    case "rescheduled":
      return "communication_not_established";
    default:
      return null;
  }
}

/// Pipeline rank of a stage (position in LEAD_STAGES); unknown → default stage.
export function stageRank(stage: string): number {
  return RANK[isLeadStage(stage) ? stage : DEFAULT_STAGE];
}

/// Was this lead lost BEFORE completing a consultation? Such a "Lost" is
/// premature — the lead never reached the consultation that creates value, so the
/// counsellor gets a chance to save it (§3.1).
export function isPreConsultation(stage: string): boolean {
  return stageRank(stage) < RANK.consultation_done;
}

/// Stages excluded from the "stuck in stage" SLA scan — the won + terminal states
/// where a lead legitimately rests (§3.1).
export const STAGE_SLA_EXCLUDED: LeadStage[] = ["converted", "lost"];

/// Forward-only auto-advance: returns `next` only if it's further along than the
/// current stage; otherwise null (= leave the stage untouched). Manual edits in
/// the UI bypass this and may move the stage in any direction.
export function advanceStage(current: string, next: LeadStage | null): LeadStage | null {
  if (!next) return null;
  const cur = isLeadStage(current) ? current : DEFAULT_STAGE;
  return RANK[next] > RANK[cur] ? next : null;
}
