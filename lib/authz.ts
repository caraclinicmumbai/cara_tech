// Authorization helpers that bridge the Auth.js session and the RBAC map
// (lib/rbac.ts). Use these in server actions and RSC pages to read the current
// user's role/rep and to gate capabilities. Route-level gating lives in proxy.ts.
import { auth } from "@/auth";
import { can, type Capability } from "@/lib/rbac";

export type SessionUser = {
  id?: string;
  name?: string | null;
  email?: string | null;
  role?: string;
  salesRepId?: string | null;
};

/// The signed-in user (role + linked sales-rep id), or null if not authenticated.
export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  return (session?.user as SessionUser | undefined) ?? null;
}

/// Like currentUser but throws when unauthenticated — for server actions.
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new Error("Unauthorized");
  return u;
}

/// Throw unless the signed-in user has `cap`. Returns the user for convenience.
export async function requireCapability(cap: Capability): Promise<SessionUser> {
  const u = await requireUser();
  if (!can(u.role, cap)) throw new Error("Forbidden");
  return u;
}
