// Sales pipeline stages (§3.1) — the human-facing lead lifecycle, distinct from
// `status` (the internal automation state). Stage is auto-advanced FORWARD-ONLY
// by call outcomes/events and freely editable by staff via the dashboard.
//
// Stored as stable snake_case keys; STAGE_LABELS holds the display text.
//
// This is the PERSON-track only (§multi-quote): it ends at "consultation_done".
// Conversion is NOT a lead stage any more — it lives on each Quote (a person
// converts a treatment, not a lead). See lib/quoteStages.ts.

export const LEAD_STAGES = [
  "ai_contacted",
  "ai_attempted_unreachable",
  "communication_not_established",
  "human_callback_pending",
  "in_consideration",
  "appointment_scheduled",
  "consultation_done",
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

// ── Custom stages (Settings → Pipeline, lib/pipeline.ts) ─────────────
// A custom stage's key is "<built-in>__<slug>": it sits just after that built-in, so
// it ranks in the pipeline without a database read — auto-advance never moves a lead
// backwards past it, and reports count it as the phase it belongs to. Nothing in the
// automation moves a lead INTO a custom stage; staff do. Never after "lost".

const CUSTOM_SEP = "__";

/// The built-in stage a custom stage sits after, or null when `v` isn't a custom key.
export function customStageAnchor(v: string): LeadStage | null {
  const i = v.indexOf(CUSTOM_SEP);
  if (i <= 0) return null;
  const anchor = v.slice(0, i);
  return isLeadStage(anchor) && anchor !== LOST_STAGE && v.length > i + CUSTOM_SEP.length ? anchor : null;
}

export function customStageKey(anchor: LeadStage, slug: string): string {
  return `${anchor}${CUSTOM_SEP}${slug}`;
}

/// A built-in stage or a well-formed custom key (whether it still exists is the
/// pipeline's business — lib/pipeline.ts).
export function isStageKey(v: string): boolean {
  return isLeadStage(v) || customStageAnchor(v) !== null;
}

/// Display text without the database: the built-in default, or a custom key's slug
/// tidied up. Screens show the clinic's own names via lib/pipeline.ts; this is the
/// fallback for logs and anything that can't wait for a read.
export function stageLabel(v: string): string {
  if (isLeadStage(v)) return STAGE_LABELS[v];
  if (customStageAnchor(v)) {
    const slug = v.slice(v.indexOf(CUSTOM_SEP) + CUSTOM_SEP.length).replace(/_/g, " ");
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  }
  return v;
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

/// Pipeline rank of a stage (position in LEAD_STAGES); a custom stage ranks just after
/// its built-in (+0.5); unknown → default stage.
export function stageRank(stage: string): number {
  if (isLeadStage(stage)) return RANK[stage];
  const anchor = customStageAnchor(stage);
  return anchor ? RANK[anchor] + 0.5 : RANK[DEFAULT_STAGE];
}

/// Was this lead lost BEFORE completing a consultation? Such a "Lost" is
/// premature — the lead never reached the consultation that creates value, so the
/// counsellor gets a chance to save it (§3.1).
export function isPreConsultation(stage: string): boolean {
  return stageRank(stage) < RANK.consultation_done;
}

/// Stages excluded from the "stuck in stage" SLA scan — the terminal state where a
/// lead legitimately rests (§3.1). Note: "consultation_done" is NOT excluded here
/// (a consulted lead may still need a quote chased); instead the scan separately
/// skips any lead that already has a WON quote (§multi-quote) — see stageSla.ts.
export const STAGE_SLA_EXCLUDED: LeadStage[] = ["lost"];

/// Forward-only auto-advance: returns `next` only if it's further along than the
/// current stage; otherwise null (= leave the stage untouched). Manual edits in
/// the UI bypass this and may move the stage in any direction.
export function advanceStage(current: string, next: LeadStage | null): LeadStage | null {
  if (!next) return null;
  return RANK[next] > stageRank(current) ? next : null;
}
