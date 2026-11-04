// The two halves of the sales team (§sales teams). Every rep is on one:
//
//   pre_consultation  — works new leads up to the consultation. The ONLY team the automatic
//                       rota draws on: intake, ads, WhatsApp, first-time callers on the
//                       clinic line, and missed-call follow-ups all land here.
//   post_consultation — takes the patient on after the consultation. Gets a lead only when
//                       someone hands it over (lib/leadOwnership.ts handoverLead).
//
// Stored as a plain string on SalesRep.team, like `availability`, and validated here.
export const SALES_TEAMS = ["pre_consultation", "post_consultation"] as const;
export type SalesTeam = (typeof SALES_TEAMS)[number];

/// The team a rep is on unless someone says otherwise — everyone, before teams existed.
export const DEFAULT_SALES_TEAM: SalesTeam = "pre_consultation";

export const SALES_TEAM_LABELS: Record<SalesTeam, string> = {
  pre_consultation: "Pre-consultation",
  post_consultation: "Post-consultation",
};

export function isSalesTeam(v: string): v is SalesTeam {
  return (SALES_TEAMS as readonly string[]).includes(v);
}

export function salesTeamLabel(v: string | null | undefined): string {
  return v && isSalesTeam(v) ? SALES_TEAM_LABELS[v] : SALES_TEAM_LABELS[DEFAULT_SALES_TEAM];
}
