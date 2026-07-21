import { requireCapability } from "@/lib/authz";
import { getRolePermissionState } from "@/lib/permissions";
import { CAPABILITY_GROUPS, ROLE_LABELS } from "@/lib/rbac";
import { HierarchyMatrix } from "@/components/HierarchyMatrix";

export const dynamic = "force-dynamic";

// CRM-Admin screen: control which features each role below Admin can access. Route-
// guarded to `hierarchy.manage` in the proxy; re-checked here for defense in depth.
// Edits flow to RolePermission and rebuild the live effective matrix (lib/permissions).
export default async function HierarchyPage() {
  await requireCapability("hierarchy.manage");
  const roles = await getRolePermissionState();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Role hierarchy &amp; access</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Control which features each role can access. Toggle a capability to grant or
          revoke it, then save. Changes take effect on the next page load — the
          navigation and in-page actions each role sees update to match.{" "}
          <span className="font-medium text-black/80 dark:text-white/80">
            {ROLE_LABELS.crm_admin}
          </span>{" "}
          always has full access and can&apos;t be edited here.
        </p>
      </div>
      <HierarchyMatrix roles={roles} groups={CAPABILITY_GROUPS} />
    </div>
  );
}
