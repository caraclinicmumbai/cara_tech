"use server";

// Server actions behind the header status switcher (§presence). Reachable via
// direct POST, so each re-checks the session. They act on the caller's OWN linked
// sales-rep identity only — a login with no rep (pure admin) simply has no status.
import { currentUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { setAvailability } from "@/lib/presence";
import { isAvailability } from "@/lib/presenceStatus";

/// Heartbeat + reconcile. Records that the caller is active right now and returns
/// their current availability, so the switcher reflects a server-side auto-offline.
/// No revalidation — this fires on a timer and must not re-render the tree.
export async function pingPresence(): Promise<{ availability: string } | null> {
  const user = await currentUser();
  const repId = user?.salesRepId;
  if (!repId) return null;
  await prisma.salesRep.update({ where: { id: repId }, data: { lastActivityAt: new Date() } }).catch(() => {});
  const rep = await prisma.salesRep.findUnique({ where: { id: repId }, select: { availability: true } });
  return rep ? { availability: rep.availability } : null;
}

/// Change the caller's own availability (one tap from the header).
export async function setMyAvailability(
  value: string,
): Promise<{ ok: boolean; availability?: string; error?: string }> {
  const user = await currentUser();
  const repId = user?.salesRepId;
  if (!repId) return { ok: false, error: "No counsellor profile is linked to your login" };
  if (!isAvailability(value)) return { ok: false, error: "Unknown status" };
  await setAvailability(repId, value, { actorId: user?.id ?? null, actorEmail: user?.email ?? null });
  return { ok: true, availability: value };
}
