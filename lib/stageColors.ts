// Stage colours for leads and quotations — the clinic's colour rules (2026-11-18). One base
// colour per stage; the row tint, left bar and pill shades are derived from it in CSS
// (`.stage-row`, `.stage-pill` in app/globals.css), so these hex values are the only place a
// colour is decided. Custom stages (Settings → Pipeline) take the colour of their anchor.
import { customStageAnchor } from "@/lib/leadStages";
import { customQuoteCategory } from "@/lib/quoteStages";

/// Lead stages: a base colour each. Rows tint 8% of it (14% on hover) with a 3px bar in the
/// full colour; the stage pill is an 18% tint with the text at 70% of the colour.
export const LEAD_STAGE_COLORS: Record<string, string> = {
  ai_contacted: "#667085",
  ai_attempted_unreachable: "#8E97A8",
  communication_not_established: "#4DB2EC",
  human_callback_pending: "#1F3FA0",
  in_consideration: "#E0A400",
  appointment_scheduled: "#6CC04A",
  consultation_done: "#1A7A32",
  lost: "#D92D2D",
};

/// A lead stage's base colour. A custom stage ("<built-in>__<slug>") wears its anchor's.
export function leadStageColor(stage: string): string {
  const key = customStageAnchor(stage) ?? stage;
  return LEAD_STAGE_COLORS[key] ?? LEAD_STAGE_COLORS.ai_contacted;
}

/// The CSS variables `.stage-row` / `.stage-pill` read (app/globals.css), for a lead stage:
/// the base colour, its 8 / 14 / 18 / 35% translucent tints, and the pill's text colour —
/// 70% of the colour mixed with black (light themes), 55% with white (dark).
export function stageVars(stage: string): Record<string, string> {
  const hex = leadStageColor(stage);
  const alpha = (pct: number) => hex + Math.round((pct / 100) * 255).toString(16).padStart(2, "0").toUpperCase();
  return {
    "--stage": hex,
    "--stage-a8": alpha(8),
    "--stage-a14": alpha(14),
    "--stage-a18": alpha(18),
    "--stage-a35": alpha(35),
    "--stage-ink": mix(hex, "#000000", 0.7),
    "--stage-ink-dark": mix(hex, "#FFFFFF", 0.55),
  };
}

/// `weight` of colour `a` mixed with the rest of `b`, as #RRGGBB.
function mix(a: string, b: string, weight: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    "#" +
    [0, 1, 2]
      .map((i) => Math.round(ch(a, i) * weight + ch(b, i) * (1 - weight)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

/// Quotation statuses: a solid pill each, with black or white text — whichever reads better
/// on it. These are the rules' default "soft pastel" intensity (30) worked out to hex.
/// The rules name seven stages; the CRM has twelve, so:
///   - Accepted and Awaiting Payment are the rules' one "Accepted — Awaiting Payment" stage;
///   - In Treatment and Completed come after Converted and share its dark green;
///   - Replaced is a withdrawn-in-favour-of-another quote, so it shares Withdrawn;
///   - Drafted (not yet sent) is a neutral grey.
export const QUOTE_STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  drafted: { bg: "#E4E7EC", fg: "#000000" },
  sent: { bg: "#9FC5F1", fg: "#000000" },
  viewed: { bg: "#B9A2EE", fg: "#000000" },
  accepted: { bg: "#C7F0C5", fg: "#000000" },
  awaiting_payment: { bg: "#C7F0C5", fg: "#000000" },
  converted: { bg: "#1F7B50", fg: "#FFFFFF" },
  in_treatment: { bg: "#1F7B50", fg: "#FFFFFF" },
  completed: { bg: "#1F7B50", fg: "#FFFFFF" },
  rejected: { bg: "#F07A82", fg: "#000000" },
  expired: { bg: "#F3AFA5", fg: "#000000" },
  replaced: { bg: "#E3C9CC", fg: "#000000" },
  withdrawn: { bg: "#E3C9CC", fg: "#000000" },
};

/// A quotation status's pill colours. A custom status takes Drafted's grey while open and
/// Withdrawn's dusty red once closed.
export function quoteStatusColor(status: string): { bg: string; fg: string } {
  const custom = customQuoteCategory(status);
  if (custom) return custom === "closed" ? QUOTE_STATUS_COLORS.withdrawn : QUOTE_STATUS_COLORS.drafted;
  return QUOTE_STATUS_COLORS[status] ?? QUOTE_STATUS_COLORS.drafted;
}
