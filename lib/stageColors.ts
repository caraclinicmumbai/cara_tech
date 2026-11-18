// Stage colours for leads and quotations — the clinic's colour rules (2026-11-18). One base
// colour per stage; the row tint, left bar and pill shades are derived from it (`stageVars`
// and `.stage-row` / `.stage-pill` in app/globals.css). The clinic can change any of them
// under Settings → Colours (saved on PipelineStatus.color, served by lib/pipeline.ts); the
// values here are the defaults. Custom stages default to the colour of their anchor.
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

/// A lead stage's DEFAULT base colour. A custom stage ("<built-in>__<slug>") wears its anchor's.
export function leadStageColor(stage: string): string {
  const key = customStageAnchor(stage) ?? stage;
  return LEAD_STAGE_COLORS[key] ?? LEAD_STAGE_COLORS.ai_contacted;
}

/// Quotation statuses: the pill background, at the rules' default "soft pastel" intensity
/// (30) worked out to hex; the text is black or white, whichever reads better (`pillInk`).
/// The rules name seven stages; the CRM has twelve, so:
///   - Accepted and Awaiting Payment are the rules' one "Accepted — Awaiting Payment" stage;
///   - In Treatment and Completed come after Converted and share its dark green;
///   - Replaced is a withdrawn-in-favour-of-another quote, so it shares Withdrawn;
///   - Drafted (not yet sent) is a neutral grey.
export const QUOTE_STATUS_COLORS: Record<string, string> = {
  drafted: "#E4E7EC",
  sent: "#9FC5F1",
  viewed: "#B9A2EE",
  accepted: "#C7F0C5",
  awaiting_payment: "#C7F0C5",
  converted: "#1F7B50",
  in_treatment: "#1F7B50",
  completed: "#1F7B50",
  rejected: "#F07A82",
  expired: "#F3AFA5",
  replaced: "#E3C9CC",
  withdrawn: "#E3C9CC",
};

/// A quotation status's DEFAULT pill colour. A custom status takes Drafted's grey while
/// open and Withdrawn's dusty red once closed.
export function quoteStatusColor(status: string): string {
  const custom = customQuoteCategory(status);
  if (custom) return custom === "closed" ? QUOTE_STATUS_COLORS.withdrawn : QUOTE_STATUS_COLORS.drafted;
  return QUOTE_STATUS_COLORS[status] ?? QUOTE_STATUS_COLORS.drafted;
}

/// A #RRGGBB colour, as the Settings colour picker sends it.
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

/// Black or white text on `bg`, whichever has the higher contrast (WCAG luminance).
export function pillInk(bg: string): "#000000" | "#FFFFFF" {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const [r, g, b] = [0, 1, 2].map((i) => lin(channel(bg, i) / 255));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? "#000000" : "#FFFFFF";
}

/// The CSS variables `.stage-row` / `.stage-pill` read (app/globals.css), for a lead stage's
/// base colour: the colour, its 8 / 14 / 18 / 35% translucent tints, and the pill's text —
/// 70% of the colour mixed with black (light themes), 55% with white (dark).
export function stageVars(color: string): Record<string, string> {
  const hex = isHexColor(color) ? color.toUpperCase() : LEAD_STAGE_COLORS.ai_contacted;
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

function channel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/// `weight` of colour `a` mixed with the rest of `b`, as #RRGGBB.
function mix(a: string, b: string, weight: number): string {
  return (
    "#" +
    [0, 1, 2]
      .map((i) => Math.round(channel(a, i) * weight + channel(b, i) * (1 - weight)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}
