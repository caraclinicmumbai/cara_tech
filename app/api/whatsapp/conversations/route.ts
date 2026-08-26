// The WhatsApp inbox's conversation list (§whatsapp inbox). The tab polls this so
// a new patient reply moves its chat to the top — and raises its unread badge —
// without a reload. Scoped to what the signed-in user may see.
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { listConversations } from "@/lib/whatsappInbox";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensurePermissions();
  if (!can(user.role, "leads.whatsapp")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const conversations = await listConversations(user);
  return NextResponse.json(
    { conversations, unread: conversations.reduce((n, c) => n + c.unread, 0) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
