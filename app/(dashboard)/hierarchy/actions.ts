"use server";

// Server Actions for the Hierarchy screen (§3.1). A CRM Admin edits the role →
// capability matrix for the roles below them; changes are persisted to RolePermission,
// the in-process effective matrix is rebuilt immediately, and an audit row is written.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { reloadPermissions, isEditableRole } from "@/lib/permissions";
import { CAPABILITIES, ROLE_CAPABILITIES, type Capability, type Role } from "@/lib/rbac";

const CAP_SET: ReadonlySet<string> = new Set(CAPABILITIES);

type Result = { ok: boolean; error?: string };

function cleanCaps(input: string[]): Capability[] {
  const seen = new Set<Capability>();
  for (const c of input) if (CAP_SET.has(c)) seen.add(c as Capability);
  // Canonical order for a stable stored value.
  return CAPABILITIES.filter((c) => seen.has(c));
}

/// Persist the full capability set for one editable role. Rejects crm_admin and any
/// unknown role (Admin is always all-access and cannot be edited).
export async function saveRolePermissions(role: string, capabilities: string[]): Promise<Result> {
  const actor = await requireCapability("hierarchy.manage");
  if (!isEditableRole(role)) return { ok: false, error: "That role cannot be edited." };

  const caps = cleanCaps(capabilities);
  const previous = await prisma.rolePermission.findUnique({ where: { role } });

  await prisma.rolePermission.upsert({
    where: { role },
    create: { role, capabilities: caps, updatedById: actor.id ?? null },
    update: { capabilities: caps, updatedById: actor.id ?? null },
  });

  await prisma.auditLog.create({
    data: {
      actorId: actor.id ?? null,
      actorEmail: actor.email ?? null,
      action: "role.permissions.change",
      entityType: "role",
      entityId: role,
      oldValue: JSON.stringify((previous?.capabilities as string[] | undefined) ?? "default"),
      newValue: JSON.stringify(caps),
      meta: { count: caps.length },
    },
  });

  await reloadPermissions(); // rebuild the effective matrix in this instance
  revalidatePath("/hierarchy");
  revalidatePath("/", "layout"); // nav gating re-renders from the new matrix
  return { ok: true };
}

/// Drop a role's override row so it reverts to the built-in defaults in lib/rbac.ts.
export async function resetRolePermissions(role: string): Promise<Result> {
  const actor = await requireCapability("hierarchy.manage");
  if (!isEditableRole(role)) return { ok: false, error: "That role cannot be edited." };

  const previous = await prisma.rolePermission.findUnique({ where: { role } });
  if (!previous) return { ok: true }; // already at defaults

  await prisma.rolePermission.delete({ where: { role } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id ?? null,
      actorEmail: actor.email ?? null,
      action: "role.permissions.reset",
      entityType: "role",
      entityId: role,
      oldValue: JSON.stringify(previous.capabilities),
      newValue: JSON.stringify(CAPABILITIES.filter((c) => ROLE_CAPABILITIES[role as Role].has(c))),
    },
  });

  await reloadPermissions();
  revalidatePath("/hierarchy");
  revalidatePath("/", "layout");
  return { ok: true };
}
