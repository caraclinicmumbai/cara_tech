// Server-side resolver for the admin-editable role → capability matrix (§3.1
// Hierarchy settings). Merges DB overrides (RolePermission rows) over the built-in
// defaults in lib/rbac.ts and installs the result as the "effective" matrix that
// `can()` reads everywhere. The matrix is cached in-process (Railway runs a single
// long-lived Node instance) and rebuilt on every admin save.
//
// Warming: call `ensurePermissions()` at each async enforcement entry point
// (requireCapability, requireApiCapability, the proxy route guard, the dashboard
// layout). It is a no-op once warm. If the DB is unreachable (e.g. the proxy runs in
// an environment without Prisma), it leaves the built-in defaults in place and does
// NOT mark warm, so a later Node-side call retries — page/action guards still enforce
// overrides because they always run in the Node runtime.
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  EDITABLE_ROLES,
  ROLE_LABELS,
  setEffectiveCapabilities,
  type Role,
  type Capability,
} from "@/lib/rbac";

const CAP_SET: ReadonlySet<string> = new Set(CAPABILITIES);

// When the effective matrix was last loaded (epoch ms), on globalThis so it is shared
// across module graphs (proxy vs app) in a single Node process. A short TTL bounds
// staleness as a safety net; admin saves refresh immediately via reloadPermissions().
const TTL_MS = 15_000;
const globalForPerms = globalThis as unknown as { __caraPermsLoadedAt?: number };

type EditableRole = Exclude<Role, "crm_admin">;

/// Sanitize a stored capabilities value into a valid Capability set (drops any key
/// that is no longer a known capability, e.g. after a rename/removal).
function sanitize(value: unknown): Set<Capability> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((c): c is Capability => typeof c === "string" && CAP_SET.has(c)));
}

/// Build the effective matrix for the editable roles from the DB override rows,
/// falling back to the built-in defaults where a role has no row.
function buildMatrix(
  rows: { role: string; capabilities: unknown }[],
): Record<EditableRole, ReadonlySet<Capability>> {
  const matrix = {} as Record<EditableRole, ReadonlySet<Capability>>;
  for (const role of EDITABLE_ROLES) {
    const row = rows.find((r) => r.role === role);
    matrix[role] = row ? sanitize(row.capabilities) : new Set(ROLE_CAPABILITIES[role]);
  }
  return matrix;
}

/// Load overrides from the DB and install the effective matrix. Always reloads
/// (ignores the warm flag) — used after an admin save and by `ensurePermissions`.
export async function reloadPermissions(): Promise<void> {
  try {
    const rows = await prisma.rolePermission.findMany({
      select: { role: true, capabilities: true },
    });
    setEffectiveCapabilities(buildMatrix(rows));
    globalForPerms.__caraPermsLoadedAt = Date.now();
  } catch (err) {
    logger.error(`permissions: failed to load role overrides — using defaults: ${String(err)}`);
    // Leave defaults in place; don't stamp loadedAt so a later call retries.
  }
}

/// Warm the effective matrix if cold or older than the TTL. Cheap no-op inside the
/// window. The shared globalThis timestamp lets the proxy graph re-read overrides an
/// admin saved from the app graph within TTL_MS even without an explicit signal.
export async function ensurePermissions(): Promise<void> {
  const loadedAt = globalForPerms.__caraPermsLoadedAt;
  if (loadedAt && Date.now() - loadedAt < TTL_MS) return;
  await reloadPermissions();
}

/// Current effective state per editable role, for the Hierarchy screen. `customized`
/// is true when the role has an explicit override row (so "Reset to default" applies).
export async function getRolePermissionState(): Promise<
  { role: EditableRole; label: string; capabilities: Capability[]; customized: boolean }[]
> {
  const rows = await prisma.rolePermission.findMany({
    select: { role: true, capabilities: true },
  });
  return EDITABLE_ROLES.map((role) => {
    const row = rows.find((r) => r.role === role);
    const caps = row ? sanitize(row.capabilities) : new Set(ROLE_CAPABILITIES[role]);
    return {
      role,
      label: ROLE_LABELS[role],
      // Emit in canonical CAPABILITIES order for stable rendering.
      capabilities: CAPABILITIES.filter((c) => caps.has(c)),
      customized: !!row,
    };
  });
}

/// True when `role` is one an admin may edit in the Hierarchy screen.
export function isEditableRole(role: string): role is EditableRole {
  return (EDITABLE_ROLES as readonly string[]).includes(role);
}

// Re-export for callers that only need the role list.
export { ROLES };
