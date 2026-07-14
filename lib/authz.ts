// Authorization helpers that bridge the Auth.js session and the RBAC map
// (lib/rbac.ts). Use these in server actions and RSC pages to read the current
// user's role/rep and to gate capabilities. Route-level gating lives in proxy.ts.
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { can, leadScope, type Capability } from "@/lib/rbac";

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

/// A Prisma `where` fragment restricting leads to what this user may see. "all"
/// scope → no restriction; "own" → leads assigned to their rep OR created by them.
/// Spread into a query's where: `{ deletedAt: null, ...leadWhereForUser(user) }`.
export function leadWhereForUser(user: SessionUser): Prisma.LeadWhereInput {
  if (leadScope(user.role) === "all") return {};
  const or: Prisma.LeadWhereInput[] = [];
  if (user.salesRepId) or.push({ assignedRepId: user.salesRepId });
  if (user.id) or.push({ createdById: user.id });
  // No identifier at all → show nothing rather than everything.
  if (or.length === 0) return { id: "__none__" };
  return { OR: or };
}

/// True if this user may see the given lead (owner scope check for one record).
export function canSeeLead(
  user: SessionUser,
  lead: { assignedRepId: string | null; createdById: string | null },
): boolean {
  if (leadScope(user.role) === "all") return true;
  return (
    (!!user.salesRepId && lead.assignedRepId === user.salesRepId) ||
    (!!user.id && lead.createdById === user.id)
  );
}
