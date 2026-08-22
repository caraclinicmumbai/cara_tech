// The header bell's feed (§handover). Returns THIS login's recent notifications
// plus the unread count; the bell polls it. Session-gated — a notification is
// addressed to a person, so there's no id to pass and nothing to scope beyond
// "whoever is signed in".
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";
import { listNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const feed = await listNotifications(user.id);
  return NextResponse.json(feed, { headers: { "Cache-Control": "no-store" } });
}
