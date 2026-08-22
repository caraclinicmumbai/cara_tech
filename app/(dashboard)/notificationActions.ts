"use server";

// Server Actions behind the header bell (§handover). Both are scoped to the signed-in
// user inside the service layer, so a guessed notification id belonging to someone
// else is a no-op rather than a leak.
import { requireUser } from "@/lib/authz";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/notifications";

export async function readNotification(id: string): Promise<void> {
  const user = await requireUser();
  if (!user.id || !id) return;
  await markNotificationRead(user.id, id);
}

export async function readAllNotifications(): Promise<void> {
  const user = await requireUser();
  if (!user.id) return;
  await markAllNotificationsRead(user.id);
}
