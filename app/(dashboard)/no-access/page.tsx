import Link from "next/link";
import { currentUser } from "@/lib/authz";
import { isRole, ROLE_LABELS, landingPath } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// The always-reachable page (§rbac). `routeCapability()` returns null for this path, so
// every signed-in user can load it whatever their capabilities.
//
// It exists so the route guard in auth.ts always has somewhere safe to send someone it
// denied. Without it, a role that can reach neither /leads nor /post-sales would bounce
// between a gated page and its redirect target forever.
export default async function NoAccessPage() {
  const user = await currentUser();
  await ensurePermissions();
  const role = user?.role;
  const home = landingPath(role);

  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <div className="cara-eyebrow">Access</div>
      <h1 className="cara-title">Nothing is assigned to your account yet</h1>
      <p className="cara-note">
        Your login{isRole(role) && <> ({ROLE_LABELS[role]})</>} doesn&apos;t currently have access to any area of the
        CRM. Ask a CRM Admin to grant your role the capabilities it needs on the Hierarchy screen.
      </p>
      {home !== "/no-access" && (
        <Link href={home} className="cara-btn cara-btn-primary inline-block">
          Go to my home page
        </Link>
      )}
    </div>
  );
}
