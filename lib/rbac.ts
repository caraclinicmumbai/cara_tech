// Role-based access control (§3.1). One central map from role → capabilities so
// every enforcement point (route guards, server actions, UI hiding) asks the same
// question: `can(role, capability)`. Roles are stored as plain strings on
// `User.role` (extensible — new roles just extend ROLES + ROLE_CAPABILITIES).

export const ROLES = [
  "front_desk",
  "telecaller",
  "branch_manager",
  "sales_head",
  "crm_admin",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  front_desk: "Front-Desk Staff",
  telecaller: "Telecaller / Counsellor",
  branch_manager: "Branch Manager",
  sales_head: "Sales Head",
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
  "leads.call",
  "leads.whatsapp",
  "leads.merge",
  "leads.markLost",
  "leads.softDelete",
  "leads.restore",
  "leads.permanentDelete",
  "calls.view",
  "analytics.view",
  "templates.manage",
  "reps.manage",
  "settings.manage",
  "users.manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

// Per the owner's access matrix. CRM Admin is a super-user (all capabilities) and
// is handled as a wildcard in `can()`, so it's omitted here.
const CAPS: Record<Exclude<Role, "crm_admin">, Capability[]> = {
  front_desk: [
    "leads.view",
    "leads.create",
    "leads.walkin",
    "leads.editStage",
    "leads.editTag",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "calls.view",
    "analytics.view",
  ],
  telecaller: [
    "leads.view",
    "leads.create",
    "leads.walkin",
    "leads.editStage",
    "leads.editTag",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "calls.view",
  ],
  branch_manager: [
    "leads.view",
    "leads.create",
    "leads.walkin",
    "leads.editStage",
    "leads.editTag",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.softDelete",
    "leads.restore",
    "calls.view",
    "analytics.view",
    "templates.manage",
    "reps.manage",
  ],
  sales_head: [
    "leads.view",
    "leads.editStage",
    "leads.editTag",
    "leads.call",
    "leads.whatsapp",
    "leads.merge",
    "leads.markLost",
    "leads.softDelete",
    "leads.restore",
    "leads.permanentDelete",
    "calls.view",
    "analytics.view",
    "reps.manage",
  ],
};

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  front_desk: new Set(CAPS.front_desk),
  telecaller: new Set(CAPS.telecaller),
  branch_manager: new Set(CAPS.branch_manager),
  sales_head: new Set(CAPS.sales_head),
  crm_admin: new Set(CAPABILITIES), // super-user
};

export function isRole(v: string | undefined | null): v is Role {
  return !!v && (ROLES as readonly string[]).includes(v);
}

/// The single access question. Unknown roles get nothing.
export function can(role: string | undefined | null, capability: Capability): boolean {
  if (!isRole(role)) return false;
  if (role === "crm_admin") return true;
  return ROLE_CAPABILITIES[role].has(capability);
}

/// Lead visibility scope for a role: "own" = only leads they own; "all" = everything.
/// Front-Desk and Telecaller are scoped to their own leads; everyone else sees all.
export function leadScope(role: string | undefined | null): "own" | "all" {
  return role === "front_desk" || role === "telecaller" ? "own" : "all";
}
