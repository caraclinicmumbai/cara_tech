// Authorization helpers that bridge the Auth.js session and the RBAC map
// (lib/rbac.ts). Use these in server actions and RSC pages to read the current
// user's role/rep and to gate capabilities. Route-level gating lives in proxy.ts.
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { can, leadScope, type Capability } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";

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
  await ensurePermissions(); // resolve admin overrides into the effective matrix
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
  // Leads they hold an active temporary access grant on (§handover — covering a
  // colleague). Widens the "own" scope for the duration of the grant.
  if (user.id) or.push({ accessGrants: { some: activeGrantWhere(user.id) } });
  // No identifier at all → show nothing rather than everything.
  if (or.length === 0) return { id: "__none__" };
  return { OR: or };
}

/// A Prisma `where` fragment restricting QUOTES to the ones a counsellor should find on
/// her own Open Quotes desk — undefined for managers, who see the whole board.
///
/// Distinct from `leadWhereForUser` on purpose. Owning the patient is not the same as
/// owning the quote: a quote can be raised by a colleague on a lead you own (§multi-quote
/// says so explicitly — "a quote's owner may differ from the lead's owner"), and the desk
/// is a personal work list, so it should hold your quotes and not theirs.
///
/// A quote with NO owner still shows on your leads' quotes: nobody else is going to pick
/// it up, and hiding it from everyone would leave real money invisible on the board. The
/// lead page is unaffected either way — open the patient and you see all their quotes,
/// because that is the context you need to work them.
/// The two clauses are ONE `OR`, not two filters AND'd together, and that distinction
/// is the whole rule. A counsellor keeps a quote she owns even when the patient has
/// since been handed to a colleague — she raised it, it's her number. AND'ing the lead
/// scope on top would take her own work off her board the moment the lead moved.
///
/// (Her board will then name a patient whose record she can't open; opening it still
/// needs the lead, or a temporary access grant. Losing the quote would be worse.)
export function quoteWhereForUser(user: SessionUser): Prisma.QuoteWhereInput | undefined {
  if (leadScope(user.role) === "all") return undefined;
  const or: Prisma.QuoteWhereInput[] = [];
  if (user.salesRepId) or.push({ ownerRepId: user.salesRepId });
  // Nobody's quote, on a lead she can see — somebody has to work it, and if it were
  // hidden from everyone with an "own" scope it would be worked by nobody.
  or.push({ ownerRepId: null, lead: leadWhereForUser(user) });
  return { OR: or };
}

/// A Prisma filter for a grant that is currently active for `userId`: not revoked and
/// not past its expiry (null expiry = until revoked).
export function activeGrantWhere(userId: string): Prisma.LeadAccessGrantWhereInput {
  return {
    granteeId: userId,
    revokedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

/// True if this user may see the given lead (owner scope check for one record). Pass
/// the lead's `accessGrants` to also honour an active temporary grant.
export function canSeeLead(
  user: SessionUser,
  lead: {
    assignedRepId: string | null;
    createdById: string | null;
    accessGrants?: { granteeId: string; revokedAt: Date | null; expiresAt: Date | null }[];
  },
): boolean {
  if (leadScope(user.role) === "all") return true;
  if (!!user.salesRepId && lead.assignedRepId === user.salesRepId) return true;
  if (!!user.id && lead.createdById === user.id) return true;
  const now = Date.now();
  return (
    !!user.id &&
    !!lead.accessGrants?.some(
      (g) => g.granteeId === user.id && !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now),
    )
  );
}

/// Async single-lead access check used by server-action guards (where the lead's grants
/// aren't already loaded). True for "all"-scope roles, the owner/creator, or an active grant.
export async function userCanAccessLead(user: SessionUser, leadId: string): Promise<boolean> {
  if (leadScope(user.role) === "all") return true;
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedRepId: true, createdById: true },
  });
  if (!lead) return false;
  if (canSeeLead(user, lead)) return true;
  if (!user.id) return false;
  const grant = await prisma.leadAccessGrant.findFirst({
    where: { leadId, ...activeGrantWhere(user.id) },
    select: { id: true },
  });
  return !!grant;
}
