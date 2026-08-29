// Role-based access control (§3.1). One central map from role → capabilities so
// every enforcement point (route guards, server actions, UI hiding) asks the same
// question: `can(role, capability)`. Roles are stored as plain strings on
// `User.role` (extensible — new roles just extend ROLES + ROLE_CAPABILITIES).

export const ROLES = [
  "front_desk",
  "telecaller",
  "telecalling_head",
  "branch_manager",
  "sales_head",
  // ── Post-sales / clinical roles (§post-sales) — the ERP side of the house. They
  //    work inside /post-sales and are deliberately NOT granted leads.view or
  //    calls.view: "the post-sales team sees the summary — not the full call
  //    recordings", so there is no route from the ERP to a recording at all. ──
  "doctor",
  "ot_team",
  "post_sales_consultant",
  "crm_admin",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  front_desk: "Front-Desk Staff",
  telecaller: "Telecaller / Counsellor",
  telecalling_head: "Telecalling Head",
  branch_manager: "Branch Manager",
  sales_head: "Sales Head",
  doctor: "Doctor / Surgeon",
  ot_team: "OT Team",
  post_sales_consultant: "Post-Sales Consultant",
  crm_admin: "CRM Admin",
};

/// Every gated capability in the app. Add one here, grant it in ROLE_CAPABILITIES,
/// then check it with `can()` at the route / action / UI layer.
export const CAPABILITIES = [
  "leads.view",
  "leads.create",
  "leads.walkin",
  "leads.editStage",
  "leads.editTag",
  // Edit a lead's core details (name / phone / email / interest). Phone edits require a
  // reason (audited). Anyone who works leads.
  "leads.edit",
  "leads.call",
  "leads.whatsapp",
  "leads.merge",
  "leads.markLost",
  // Add / delete staff notes on a lead (§notes). Anyone who works leads; a manager
  // (all-leads scope) can delete anyone's note, others only their own.
  "leads.comment",
  // Handover (§handover): transfer a lead's owner. Same-branch is open to counsellors
  // (their own lead) + managers; cross-branch is manager/admin-only + a written reason.
  "leads.handover",
  // Grant a colleague temporary access to a lead without changing ownership. Managers/admin.
  "leads.grantAccess",
  "leads.softDelete",
  "leads.restore",
  "leads.permanentDelete",
  // Export the leads list as CSV (audited). Managers/admin.
  "leads.export",
  // Quotes (Phase 2 §multi-quote): view the quotes on a lead; manage = create /
  // revise price / send / reject / withdraw; convert = mark won (needs an invoice);
  // unlock = reopen a converted (locked) quote — Admin-only, so it's granted to no
  // role here and reaches only crm_admin's wildcard.
  "quotes.view",
  "quotes.manage",
  "quotes.convert",
  "quotes.unlock",
  // §branch credit — the invoicing branch owns the credit for a quote. A branch that
  // believes the credit is theirs raises a dispute within 7 days (`quotes.disputeRaise`,
  // branch managers + admin); the Sales Head decides, once, finally
  // (`quotes.disputeDecide`). Nobody edits the credit directly.
  "quotes.disputeRaise",
  "quotes.disputeDecide",
  // Post-sales ERP (§post-sales). `view` = see the board, a journey and its handover
  // summary — granted to sales too, so a counsellor can see where their patient got
  // to. `manage` = move journey stages, assign the clinical team, record the surgery
  // date: the POST-SALES TEAM OWNS THESE STAGES and sales counsellors deliberately do
  // NOT get it. `checkins` = resolve / reschedule a care check-in. `policy` = edit the
  // per-treatment stage time limits.
  "postsales.view",
  "postsales.manage",
  "postsales.checkins",
  "postsales.policy",
  "calls.view",
  "analytics.view",
  "templates.manage",
  "chatbot.manage",
  // Win-back (§follow-up): review lost leads and approve them (singly/in a batch) for one
  // more automated try. Sales Head + Telecalling Head by default (+ Admin wildcard).
  "campaigns.winback",
  // Follow-up campaigns (§follow-up): view running campaign enrolments (the /campaigns
  // overview + the per-lead card) and STOP a lead's campaign. Everyone who works leads.
  "campaigns.manage",
  "reps.manage",
  "settings.manage",
  "users.manage",
  // View the audit trail (§compliance) — all recorded changes. Managers/admin.
  "audit.view",
  // Hierarchy settings (§3.1): edit the role → capability matrix itself. Admin-only by
  // default (granted to no role below, so it reaches only crm_admin's wildcard).
  "hierarchy.manage",
  // Branches (§branches): create / edit clinic branches. Admin-only by default (grant it
  // to a CEO/owner login via the Hierarchy screen if needed).
  "branches.manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/// The roles a CRM Admin may edit in the Hierarchy screen — everyone below Admin.
/// crm_admin is always all-access and cannot be edited (can't lock yourself out).
export const EDITABLE_ROLES = ROLES.filter((r) => r !== "crm_admin") as Exclude<Role, "crm_admin">[];

/// Capabilities grouped by feature area, with human labels — drives the Hierarchy
/// matrix UI and any capability picker. Every capability in CAPABILITIES appears once.
export const CAPABILITY_GROUPS: {
  key: string;
  label: string;
  capabilities: { key: Capability; label: string }[];
}[] = [
  {
    key: "leads",
    label: "Leads",
    capabilities: [
      { key: "leads.view", label: "View leads" },
      { key: "leads.create", label: "Create leads" },
      { key: "leads.walkin", label: "Walk-in entry" },
      { key: "leads.editStage", label: "Move pipeline stage" },
      { key: "leads.editTag", label: "Edit tag / interest" },
      { key: "leads.edit", label: "Edit details (name/phone/email)" },
      { key: "leads.call", label: "Click-to-call" },
      { key: "leads.whatsapp", label: "Send WhatsApp" },
      { key: "leads.merge", label: "Merge duplicates" },
      { key: "leads.markLost", label: "Mark lost" },
      { key: "leads.comment", label: "Add notes / comments" },
      { key: "leads.handover", label: "Hand over (transfer owner)" },
      { key: "leads.grantAccess", label: "Grant temporary access" },
      { key: "leads.softDelete", label: "Move to trash" },
      { key: "leads.restore", label: "Restore from trash" },
      { key: "leads.permanentDelete", label: "Permanently delete" },
      { key: "leads.export", label: "Export leads (CSV)" },
    ],
  },
  {
    key: "quotes",
    label: "Quotes",
    capabilities: [
      { key: "quotes.view", label: "View quotes" },
      { key: "quotes.manage", label: "Create / revise / send" },
      { key: "quotes.convert", label: "Convert (mark won)" },
      { key: "quotes.unlock", label: "Reopen locked quote" },
      { key: "quotes.disputeRaise", label: "Dispute branch credit" },
      { key: "quotes.disputeDecide", label: "Decide a credit dispute" },
    ],
  },
  {
    key: "postsales",
    label: "Post-Sales (ERP)",
    capabilities: [
      { key: "postsales.view", label: "View journeys & handover summary" },
      { key: "postsales.manage", label: "Move stages / assign clinical team" },
      { key: "postsales.checkins", label: "Manage care check-ins" },
      { key: "postsales.policy", label: "Edit per-treatment stage limits" },
    ],
  },
  {
    key: "calls",
    label: "Calls",
    capabilities: [{ key: "calls.view", label: "View call history" }],
  },
  {
    key: "analytics",
    label: "Analytics",
    capabilities: [{ key: "analytics.view", label: "Dashboard & CQS" }],
  },
  {
    key: "messaging",
    label: "Messaging & Automation",
    capabilities: [
      { key: "templates.manage", label: "WhatsApp templates" },
      { key: "chatbot.manage", label: "Chatbot flows" },
      { key: "campaigns.winback", label: "Approve win-back retries" },
      { key: "campaigns.manage", label: "View & stop campaigns" },
    ],
  },
  {
    key: "admin",
    label: "Team & Access",
    capabilities: [
      { key: "reps.manage", label: "Manage sales reps" },
      { key: "users.manage", label: "Manage staff logins" },
      { key: "audit.view", label: "View audit log" },
      { key: "hierarchy.manage", label: "Manage role hierarchy" },
      { key: "branches.manage", label: "Manage branches" },
      { key: "settings.manage", label: "System settings" },
    ],
  },
];

// Per the owner's access matrix. CRM Admin is a super-user (all capabilities) and
// is handled as a wildcard in `can()`, so it's omitted here.
const CAPS: Record<Exclude<Role, "crm_admin">, Capability[]> = {
  front_desk: [
    "leads.view",
    "leads.create",
    "leads.walkin",
    "leads.editStage",
    "leads.editTag",
    "leads.edit",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.comment",
    "calls.view",
    "analytics.view",
    // Front desk is part of the post-sales floor (§post-sales): they see the board and
    // close out care check-ins they made by phone, but they don't move clinical stages.
    "postsales.view",
    "postsales.checkins",
  ],
  telecaller: [
    "leads.view",
    "leads.create",
    "leads.walkin",
    "leads.editStage",
    "leads.editTag",
    "leads.edit",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.comment",
    "leads.handover",
    "quotes.view",
    "quotes.manage",
    "quotes.convert",
    "calls.view",
    "campaigns.manage",
    // A counsellor can SEE where their converted patient got to, but not edit the
    // clinical stages — "The Post-Sales team owns these stages. Sales counsellors
    // can't edit them." (§post-sales)
    "postsales.view",
  ],
  telecalling_head: [
    "leads.view",
    "leads.editStage",
    "leads.editTag",
    "leads.edit",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.comment",
    "leads.handover",
    "leads.grantAccess",
    "quotes.view",
    "quotes.manage",
    "quotes.convert",
    "calls.view",
    "analytics.view",
    "audit.view",
    "reps.manage",
    // Runs the telecalling floor — approves lost leads for a win-back retry.
    "campaigns.winback",
    "campaigns.manage",
    "postsales.view",
  ],
  branch_manager: [
    "leads.view",
    "leads.create",
    "leads.walkin",
    "leads.editStage",
    "leads.editTag",
    "leads.edit",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.comment",
    "leads.handover",
    "leads.grantAccess",
    "leads.softDelete",
    "leads.restore",
    "leads.export",
    "quotes.view",
    "quotes.manage",
    "quotes.convert",
    // A branch manager raises the credit dispute for their branch (§branch credit).
    "quotes.disputeRaise",
    "calls.view",
    "analytics.view",
    "audit.view",
    "templates.manage",
    "chatbot.manage",
    "reps.manage",
    "campaigns.manage",
    // Runs the clinic floor end to end — including the post-sales pipeline and the
    // per-treatment stage limits.
    "postsales.view",
    "postsales.manage",
    "postsales.checkins",
    "postsales.policy",
  ],
  sales_head: [
    "leads.view",
    "leads.editStage",
    "leads.editTag",
    "leads.edit",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.comment",
    "leads.handover",
    "leads.grantAccess",
    "leads.softDelete",
    "leads.restore",
    "leads.permanentDelete",
    "leads.export",
    "quotes.view",
    "quotes.manage",
    "quotes.convert",
    // §branch credit — the Sales Head decides a dispute, once and finally, and may
    // raise one on a branch's behalf.
    "quotes.disputeRaise",
    "quotes.disputeDecide",
    "calls.view",
    "analytics.view",
    "audit.view",
    "reps.manage",
    "campaigns.winback",
    "campaigns.manage",
    // Oversight of the clinical pipeline, but not editing it — the post-sales team owns
    // those stages.
    "postsales.view",
  ],

  // ── The post-sales / clinical roles (§post-sales). Note what is ABSENT from all
  //    three: leads.view and calls.view. They never reach the sales lead record, so
  //    they cannot reach a call recording or transcript — the handover summary on the
  //    journey page is their whole view of the patient, by design. ──
  doctor: [
    "postsales.view",
    "postsales.manage",
    "postsales.checkins",
  ],
  ot_team: [
    "postsales.view",
    // The OT team drives Pre-Op → Surgery Done and records the surgery date.
    "postsales.manage",
  ],
  post_sales_consultant: [
    "postsales.view",
    "postsales.manage",
    "postsales.checkins",
  ],
};

/// The built-in DEFAULT matrix — the fallback used when a role has no admin override
/// row, and the "Reset to default" target in the Hierarchy screen. The live, possibly
/// admin-overridden matrix is `effectiveCapabilities` below.
export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  front_desk: new Set(CAPS.front_desk),
  telecaller: new Set(CAPS.telecaller),
  telecalling_head: new Set(CAPS.telecalling_head),
  branch_manager: new Set(CAPS.branch_manager),
  sales_head: new Set(CAPS.sales_head),
  doctor: new Set(CAPS.doctor),
  ot_team: new Set(CAPS.ot_team),
  post_sales_consultant: new Set(CAPS.post_sales_consultant),
  crm_admin: new Set(CAPABILITIES), // super-user
};

// The effective (admin-overridden) matrix, hydrated from the DB by lib/permissions.ts.
// Null until warmed; while cold, `can()` falls back to the built-in defaults above so
// gating is never *more* permissive than intended. crm_admin is always all-access and
// is not represented here.
//
// Stored on globalThis so the value is SHARED between module graphs in a single Node
// process — critically the proxy/route-guard graph and the app (RSC/action) graph.
// Without this, an admin save would refresh the app graph (nav updates instantly) but
// leave the proxy's route guard stale (see lib/permissions.ts for the TTL safety net).
type EffectiveMatrix = Record<Exclude<Role, "crm_admin">, ReadonlySet<Capability>> | null;
const globalForCaps = globalThis as unknown as { __caraEffectiveCaps?: EffectiveMatrix };

/// Install the live matrix (called by lib/permissions.ts after loading DB overrides).
/// Pass null to revert to defaults. crm_admin is intentionally excluded — it is always
/// all-access via the wildcard in `can()` and can never be edited.
export function setEffectiveCapabilities(matrix: EffectiveMatrix): void {
  globalForCaps.__caraEffectiveCaps = matrix;
}

export function isRole(v: string | undefined | null): v is Role {
  return !!v && (ROLES as readonly string[]).includes(v);
}

/// The single access question. Unknown roles get nothing. crm_admin is the super-user
/// (all capabilities, never editable). Everyone else is checked against the live
/// effective matrix when warmed, otherwise the built-in defaults.
export function can(role: string | undefined | null, capability: Capability): boolean {
  if (!isRole(role)) return false;
  if (role === "crm_admin") return true;
  const matrix = globalForCaps.__caraEffectiveCaps ?? ROLE_CAPABILITIES;
  return matrix[role].has(capability);
}

/// Roles scoped to only the leads they own. Front-Desk and Telecaller work their own
/// book. The post-sales/clinical roles are listed here as a DEFENCE IN DEPTH measure:
/// they hold no `leads.view` capability, so they never reach a lead list at all — but
/// if one were ever granted it from the Hierarchy screen, they'd see only leads they
/// own (which is none) rather than the entire patient database.
const OWN_SCOPE_ROLES: readonly string[] = [
  "front_desk",
  "telecaller",
  "doctor",
  "ot_team",
  "post_sales_consultant",
];

/// Lead visibility scope for a role: "own" = only leads they own; "all" = everything.
export function leadScope(role: string | undefined | null): "own" | "all" {
  return role && OWN_SCOPE_ROLES.includes(role) ? "own" : "all";
}

/// The capability a top-level route requires, or null for routes any signed-in user
/// may reach. Used by the proxy route guard. Order matters — more specific paths first.
///
/// /leads and /calls are gated on `leads.view` / `calls.view` rather than left open:
/// the post-sales roles hold neither, which is what keeps the clinical team out of the
/// sales record and away from call recordings (§post-sales "the post-sales team sees
/// the summary — not the full call recordings").
export function routeCapability(pathname: string): Capability | null {
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/cqs")) return "analytics.view";
  if (pathname.startsWith("/post-sales/policies")) return "postsales.policy";
  if (pathname.startsWith("/post-sales")) return "postsales.view";
  if (pathname.startsWith("/templates")) return "templates.manage";
  if (pathname.startsWith("/chatbot")) return "chatbot.manage";
  if (pathname.startsWith("/settings")) return "settings.manage";
  if (pathname.startsWith("/hierarchy")) return "hierarchy.manage";
  if (pathname.startsWith("/branches")) return "branches.manage";
  if (pathname.startsWith("/win-back")) return "campaigns.winback";
  if (pathname.startsWith("/campaigns")) return "campaigns.manage";
  if (pathname.startsWith("/audit")) return "audit.view";
  if (pathname.startsWith("/users")) return "users.manage";
  if (pathname.startsWith("/leads/deleted")) return "leads.restore";
  if (pathname.startsWith("/leads/walk-in")) return "leads.walkin";
  if (pathname.startsWith("/leads")) return "leads.view";
  if (pathname.startsWith("/whatsapp")) return "leads.whatsapp";
  if (pathname.startsWith("/calls")) return "calls.view";
  if (pathname.startsWith("/quotes")) return "quotes.view";
  return null;
}

/// A page every signed-in user can reach, whatever their capabilities. It exists so
/// the route guard always has somewhere safe to send a denied user — without it, a role
/// that can reach neither /leads nor /post-sales would bounce between a gated page and
/// the redirect target forever.
export const NO_ACCESS_PATH = "/no-access";

/// Where a role lands after signing in, and where the route guard sends someone who
/// lacks a page's capability. The clinical roles have no business on the sales lead
/// list — and /leads is gated on `leads.view`, which they don't hold — so they go
/// straight to the post-sales board. Falls back to NO_ACCESS_PATH when the role can't
/// reach its own landing page (possible once an admin edits the Hierarchy matrix),
/// which is what keeps the guard loop-free.
export function landingPath(role: string | undefined | null): string {
  const preferred =
    role === "doctor" || role === "ot_team" || role === "post_sales_consultant" ? "/post-sales" : "/leads";
  const cap = routeCapability(preferred);
  if (cap && !can(role, cap)) return NO_ACCESS_PATH;
  return preferred;
}
