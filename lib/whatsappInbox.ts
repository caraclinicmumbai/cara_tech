// The WhatsApp inbox (§whatsapp inbox) — the conversation list behind the WhatsApp
// tab. One row per lead that has ever exchanged a message, newest activity first,
// with the unread count that makes the tab a notification surface rather than a
// second lead list.
//
// Scope is the same as everywhere else: a telecaller sees the conversations of
// leads they own or cover, a manager sees all (lib/authz).
import { prisma } from "@/lib/prisma";
import { leadWhereForUser, type SessionUser } from "@/lib/authz";
import { SERVICE_WINDOW_MS } from "@/lib/messages";

export type ConversationRow = {
  leadId: string;
  name: string;
  phone: string;
  ownerName: string | null;
  optedOut: boolean;
  /// Preview of the newest message, whichever direction it went.
  lastMessage: string;
  lastDirection: "inbound" | "outbound";
  lastAt: string; // ISO
  /// Inbound messages this user hasn't seen.
  unread: number;
  /// Is the 24h free-form window open (drives the composer, shown as a hint here).
  windowOpen: boolean;
};

/// Short, single-line preview for the list — media and interactive messages don't
/// have a body worth showing raw.
function preview(body: string | null, type: string): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  if (type === "image") return "📷 Photo";
  if (type === "document") return "📎 Document";
  if (type === "audio") return "🎤 Voice note";
  if (type === "video") return "🎬 Video";
  return `[${type}]`;
}

/// Every conversation this user may see, newest first.
export async function listConversations(user: SessionUser): Promise<ConversationRow[]> {
  // Only leads that actually have a thread — this is an inbox, not the lead list.
  const leads = await prisma.lead.findMany({
    where: { deletedAt: null, messages: { some: {} }, ...leadWhereForUser(user) },
    select: {
      id: true,
      name: true,
      phone: true,
      optedOut: true,
      assignedRep: { select: { name: true } },
    },
  });
  if (leads.length === 0) return [];
  const ids = leads.map((l) => l.id);

  const [latest, inbound, reads] = await Promise.all([
    // Newest message per lead: `distinct` keeps the first row per leadId in the
    // given order, so ordering by createdAt desc gives exactly the latest.
    prisma.message.findMany({
      where: { leadId: { in: ids } },
      orderBy: { createdAt: "desc" },
      distinct: ["leadId"],
      select: { leadId: true, body: true, type: true, direction: true, createdAt: true },
    }),
    // Inbound timestamps drive both the unread count and the 24h window, and there
    // are few enough per lead to count in memory rather than N queries.
    prisma.message.findMany({
      where: { leadId: { in: ids }, direction: "inbound" },
      select: { leadId: true, createdAt: true },
    }),
    user.id
      ? prisma.chatRead.findMany({
          where: { userId: user.id, leadId: { in: ids } },
          select: { leadId: true, lastReadAt: true },
        })
      : Promise.resolve([]),
  ]);

  const lastOf = new Map(latest.map((m) => [m.leadId, m]));
  const readAt = new Map(reads.map((r) => [r.leadId, r.lastReadAt.getTime()]));
  const inboundBy = new Map<string, number[]>();
  for (const m of inbound) {
    const list = inboundBy.get(m.leadId) ?? [];
    list.push(m.createdAt.getTime());
    inboundBy.set(m.leadId, list);
  }

  const now = Date.now();
  const rows: ConversationRow[] = [];
  for (const lead of leads) {
    const last = lastOf.get(lead.id);
    if (!last) continue; // no messages after all
    const times = inboundBy.get(lead.id) ?? [];
    // No read row = never opened by this user, so every inbound message is unread.
    const seenUpTo = readAt.get(lead.id) ?? 0;
    const unread = times.filter((t) => t > seenUpTo).length;
    const lastInbound = times.length ? Math.max(...times) : 0;
    rows.push({
      leadId: lead.id,
      name: lead.name,
      phone: lead.phone,
      ownerName: lead.assignedRep?.name ?? null,
      optedOut: lead.optedOut,
      lastMessage: preview(last.body, last.type),
      lastDirection: last.direction === "inbound" ? "inbound" : "outbound",
      lastAt: last.createdAt.toISOString(),
      unread,
      windowOpen: lastInbound > 0 && now - lastInbound < SERVICE_WINDOW_MS,
    });
  }

  rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return rows;
}

/// Total unread inbound messages across this user's conversations — the badge on
/// the WhatsApp tab.
export async function unreadTotal(user: SessionUser): Promise<number> {
  const rows = await listConversations(user);
  return rows.reduce((sum, r) => sum + r.unread, 0);
}

/// Mark a conversation caught up for this user, up to `at` (defaults to now).
export async function markConversationRead(
  userId: string,
  leadId: string,
  at: Date = new Date(),
): Promise<void> {
  await prisma.chatRead.upsert({
    where: { userId_leadId: { userId, leadId } },
    create: { userId, leadId, lastReadAt: at },
    update: { lastReadAt: at },
  });
}
