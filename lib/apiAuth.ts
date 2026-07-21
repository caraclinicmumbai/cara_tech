// Session gating for API route handlers.
// Routes under /api are NOT covered by proxy.ts (its matcher excludes `api`),
// so dashboard-facing data endpoints must check the Auth.js session themselves.
// External / automation endpoints use shared-secret or signature verification
// instead (see lib/verify.ts and the /api/intake/* adapters).
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { can, type Capability } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";

/// Returns a 401 response when there is no authenticated user session, else null.
/// Usage:  const denied = await requireSession(); if (denied) return denied;
export async function requireSession(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/// Gate an API route by RBAC capability. Returns `{ denied: <response> }` to return
/// early (401/403), or `{ denied: null, userId }` for the authorized caller
/// (e.g. to stamp createdById on a new lead).
export async function requireApiCapability(
  cap: Capability,
): Promise<{ denied: NextResponse; userId?: undefined } | { denied: null; userId?: string }> {
  const session = await auth();
  const user = session?.user as { id?: string; role?: string } | undefined;
  if (!user) return { denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  await ensurePermissions(); // resolve admin overrides into the effective matrix
  if (!can(user.role, cap)) {
    return { denied: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { denied: null, userId: user.id };
}
