// Follow-up campaign definitions (Phase 2 §follow-up). The seven campaigns are DATA:
// a schedule of WhatsApp template steps plus an optional terminal action. The engine
// (lib/campaigns/engine.ts) and the guardrail gate (lib/campaigns/eligibility.ts) are
// campaign-agnostic — they read these definitions. Stage 1 ships the guardrails + the
// engine + ONE proof campaign ("Couldn't Reach Them"); the other six are declared here
// (so the per-branch toggle UI can list them) but have no steps yet.

/// Stable machine keys for the seven campaigns. Stored on CampaignEnrollment.campaignType
/// and CampaignSetting.campaignType. Order = display order in the toggle UI.
export const CAMPAIGN_TYPES = [
  "hot_lead",
  "worried_cost",
  "just_researching",
  "couldnt_reach",
  "international",
  "win_back",
  "dead_lead_bulk",
] as const;

export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export function isCampaignType(v: string): v is CampaignType {
  return (CAMPAIGN_TYPES as readonly string[]).includes(v);
}

/// One scheduled touch in a campaign: fire the (approved) WhatsApp template named by the
/// env var, `dayOffset` days after the enrollment started. Template unset = the step is a
/// safe no-op (nothing sends) but the schedule still advances, so configuring templates
/// later doesn't require re-enrolling anyone.
export type CampaignStep = {
  dayOffset: number;
  /// Approved WhatsApp template name for this step (env-gated; undefined = disabled).
  template: () => string | undefined;
};

/// A campaign is its ordered steps plus what happens after the last one.
export type CampaignDef = {
  type: CampaignType;
  label: string;
  description: string;
  /// Stage 1 is WhatsApp-only; email (International Patient) is deferred to a later stage.
  channel: "whatsapp";
  steps: CampaignStep[];
  /// Terminal action once the final step has been sent. "mark_lost" moves the lead to the
  /// Lost stage (Couldn't Reach Them). Omitted = the enrollment just completes.
  onComplete?: "mark_lost";
  /// Free-text lost reason recorded when onComplete = "mark_lost".
  lostReason?: string;
};

const env = (name: string) => () => process.env[name];

/// Registry of all seven campaigns. Only "couldnt_reach" has steps in Stage 1.
export const CAMPAIGNS: Record<CampaignType, CampaignDef> = {
  hot_lead: {
    type: "hot_lead",
    label: "Hot Lead — Fast Track",
    description: "Score 75+, in a hurry. A counsellor calls within 2 hours (routing, not messaging).",
    channel: "whatsapp",
    steps: [], // handled via handover + SLA routing, wired in a later stage
  },
  worried_cost: {
    type: "worried_cost",
    label: "Worried About Cost",
    description: "Value & financing messages on days 1, 3, 7, 14.",
    channel: "whatsapp",
    steps: [
      { dayOffset: 1, template: env("WHATSAPP_TEMPLATE_WC_DAY1") },
      { dayOffset: 3, template: env("WHATSAPP_TEMPLATE_WC_DAY3") },
      { dayOffset: 7, template: env("WHATSAPP_TEMPLATE_WC_DAY7") },
      { dayOffset: 14, template: env("WHATSAPP_TEMPLATE_WC_DAY14") },
    ],
  },
  just_researching: {
    type: "just_researching",
    label: "Just Researching",
    description: "Weekly educational content, maximum 6 messages.",
    channel: "whatsapp",
    // Weekly for six weeks = the spec's "maximum 6 messages" (the step count IS the cap).
    steps: [
      { dayOffset: 7, template: env("WHATSAPP_TEMPLATE_JR_WK1") },
      { dayOffset: 14, template: env("WHATSAPP_TEMPLATE_JR_WK2") },
      { dayOffset: 21, template: env("WHATSAPP_TEMPLATE_JR_WK3") },
      { dayOffset: 28, template: env("WHATSAPP_TEMPLATE_JR_WK4") },
      { dayOffset: 35, template: env("WHATSAPP_TEMPLATE_JR_WK5") },
      { dayOffset: 42, template: env("WHATSAPP_TEMPLATE_JR_WK6") },
    ],
  },
  couldnt_reach: {
    type: "couldnt_reach",
    label: "Couldn't Reach Them",
    description: "Messages on days 1, 5, 14, 30 — then the lead is marked Lost.",
    channel: "whatsapp",
    steps: [
      { dayOffset: 1, template: env("WHATSAPP_TEMPLATE_CR_DAY1") },
      { dayOffset: 5, template: env("WHATSAPP_TEMPLATE_CR_DAY5") },
      { dayOffset: 14, template: env("WHATSAPP_TEMPLATE_CR_DAY14") },
      { dayOffset: 30, template: env("WHATSAPP_TEMPLATE_CR_DAY30") },
    ],
    onComplete: "mark_lost",
    lostReason: "Unreachable — exhausted the Couldn't-Reach follow-up campaign",
  },
  international: {
    type: "international",
    label: "International Patient",
    description: "WhatsApp + email in English (email deferred to a later stage).",
    channel: "whatsapp",
    steps: [], // later stage (needs email provider)
  },
  win_back: {
    type: "win_back",
    label: "Win-Back",
    description: "90 days after Lost, a warm low-pressure message. Maximum 4 a year.",
    channel: "whatsapp",
    steps: [], // later stage
  },
  dead_lead_bulk: {
    type: "dead_lead_bulk",
    label: "Dead Lead Bulk",
    description: "Sales Head approves a batch of old lost leads for one more try.",
    channel: "whatsapp",
    steps: [], // later stage
  },
};

/// Global kill-switch for the whole follow-up engine (mirrors AI_CALLS_PAUSED for calls).
/// OFF by default: nothing enrolls or sends until CAMPAIGNS_ENABLED is explicitly truthy,
/// so deploying this code can't start messaging anyone by surprise.
export function campaignsEnabled(): boolean {
  const v = (process.env.CAMPAIGNS_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}
