// In-app notifications — what the bell in the dashboard header shows (§handover).
//
// The rule that shapes this module: a notification must reach the PERSON, in the
// software, whether or not they were online when it fired. So it's a durable row
// keyed to a login, not a push/toast; Slack (when configured) is an extra channel
// layered on top, never the only one.
//
// Every writer is best-effort: failing to raise a bell must not break the flow that
// triggered it (a handover still happens even if its notification doesn't).
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/// What a notification is about. Kept as strings (not an enum) to match the rest of
/// the schema and so a new kind doesn't need a migration.
export type NotificationKind = "handover" | "handover_cover";

export type NotifyInput = {
  /// Recipient login (User.id).
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  /// The lead this is about — the bell entry links straight to it.
  leadId?: string | null;
  /// Stable key that makes a repeat trigger a no-op (a retried webhook, a second
  /// handover in the same cycle). Omit to always create a new row.
  dedupeKey?: string | null;
};

/// Raise one in-app notification. Returns false when it was deduped or failed —
/// callers treat it as advisory.
export async function notifyUser(input: NotifyInput): Promise<boolean> {
  if (!input.userId) return false;
  try {
    if (input.dedupeKey) {
      // upsert, not create — the unique dedupeKey turns a repeat into a no-op
      // without a race between "check" and "insert".
      const existing = await prisma.notification.findUnique({
        where: { dedupeKey: input.dedupeKey },
        select: { id: true },
      });
      if (existing) return false;
    }
    await prisma.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        leadId: input.leadId ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
    });
    return true;
  } catch (err) {
    // A unique-constraint hit here is the dedupe doing its job under a race.
    if (String(err).includes("Unique constraint")) return false;
    logger.error(`Notification for user ${input.userId} failed: ${String(err)}`);
    return false;
  }
}

/// The login linked to a sales rep (User.salesRepId is unique), or null when that
/// counsellor has no CRM account — they can be pinged on Slack but have no bell.
export async function userIdForRep(repId: string | null | undefined): Promise<string | null> {
  if (!repId) return null;
  const user = await prisma.user.findFirst({ where: { salesRepId: repId }, select: { id: true } });
  return user?.id ?? null;
}

/// Raise a notification for a REP (resolving their login first). No-op when the rep
/// has no linked account.
export async function notifyRep(
  repId: string | null | undefined,
  input: Omit<NotifyInput, "userId">,
): Promise<boolean> {
  const userId = await userIdForRep(repId);
  if (!userId) {
    logger.warn(`No login linked to rep ${repId} — in-app notification skipped (${input.kind})`);
    return false;
  }
  return notifyUser({ ...input, userId });
}

export type NotificationView = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  leadId: string | null;
  read: boolean;
  createdAt: string;
};

const FEED_LIMIT = 20;

/// The bell's feed: this login's most recent notifications plus the unread count.
export async function listNotifications(
  userId: string,
): Promise<{ items: NotificationView[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: FEED_LIMIT,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return {
    unread,
    items: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      leadId: n.leadId,
      read: !!n.readAt,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

/// Mark one notification read. Scoped to the owner so an id can't be guessed.
export async function markNotificationRead(userId: string, id: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
}

/// Mark every unread notification for this login read.
export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}
