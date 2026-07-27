// Call → campaign classifier (Phase 2 §follow-up). Sorts a lead into a follow-up campaign
// based on HOW the AI call went, from signals the agent already emits — never by hand.
// Called post-commit from lib/callIntake.ts with the outcome of the just-recorded call.
//
// Design rules (user-approved):
//   • Handover ALWAYS wins — if the call handed the lead to a human, no automated drip.
//   • A lead already in a campaign is untouched (enrollLead's one-active-per-person guard).
//   • Conservative: only enrol on a clear signal; ambiguous calls get no campaign (a human
//     decides). couldnt_reach is the one exception — it's driven by the call ladder, not here.
import type { CampaignType } from "@/lib/campaigns/types";

/// Cost/financing vocabulary — a hit in the call's tag or handover reasons means the lead
/// is price-sensitive → the Worried-About-Cost drip (unless it also triggered handover).
const COST_RE =
  /\b(price|pricing|cost|costs|costly|emi|instal?ments?|budget|afford|affordab|expensive|financ|loan|discount|offer|cheap|rate|quote)\b/i;

export type CallSignals = {
  /// The call ladder exhausted with no answer (Stage 1's recovery trigger).
  becameUnreachable: boolean;
  /// A retry call is already scheduled — the lead is still being dialled, don't drip yet.
  retryScheduled: boolean;
  /// The call handed the lead to a human (any handover trigger, incl. hot-lead high CQS).
  handoverFired: boolean;
  /// The lead opted out on this call ("not interested").
  optedOut: boolean;
  /// An appointment was confirmed — they're in the pipeline, no nurture needed.
  confirmed: boolean;
  /// A callback call was scheduled (rescheduled / asked to be called back).
  callbackScheduled: boolean;
  /// The call actually connected (a real conversation happened).
  answered: boolean;
  /// What the lead asked for, as captured by the AI (drives the cost-signal match).
  tag?: string | null;
  /// AI-flagged handover reason keys (also scanned for a cost signal).
  handoverReasons?: string[];
  /// AI-assessed interest level, when available: high | medium | low.
  interestLevel?: string | null;
};

/// Pick the follow-up campaign for a just-recorded call, or null for "no automated campaign".
export function classifyFromCall(s: CallSignals): CampaignType | null {
  // Recovery: unreachable after the full call ladder → Couldn't Reach Them.
  if (s.becameUnreachable) return "couldnt_reach";

  // Any stronger path owns the lead — no drip.
  if (s.retryScheduled) return null; // still being called
  if (s.optedOut) return null;
  if (s.handoverFired) return null; // handover always wins
  if (s.confirmed) return null; // booked
  if (s.callbackScheduled) return null; // has an active callback

  // Only nurture a lead we actually spoke to.
  if (!s.answered) return null;

  // Price-sensitive (but not handed to a human) → Worried About Cost. Handover reason keys
  // are snake_case (e.g. "price_request"); underscore is a word char, so swap it for a space
  // before matching or the \bprice\b boundary never fires.
  const cost =
    (s.tag ? COST_RE.test(s.tag) : false) ||
    (s.handoverReasons ?? []).some((r) => COST_RE.test(r.replace(/_/g, " ")));
  if (cost) return "worried_cost";

  // A hot lead that somehow didn't hand over is left for a human, not a slow drip.
  if (s.interestLevel === "high") return null;

  // Otherwise a warm-but-browsing lead → the low-pressure educational nurture.
  return "just_researching";
}
