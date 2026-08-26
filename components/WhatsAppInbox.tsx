"use client";

// The conversation list of the WhatsApp tab (§whatsapp inbox) — the left pane of
// the WhatsApp-Web-style split. Shows every lead with a thread, newest first, with
// an unread badge; selecting one opens it in the right pane and marks it read.
//
// Polls the list (the open thread has its own SSE stream), so a reply that arrives
// while an agent is reading a different chat still bubbles to the top.
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { readConversation } from "@/app/(dashboard)/whatsapp/actions";

export type ConversationRow = {
  leadId: string;
  name: string;
  phone: string;
  ownerName: string | null;
  optedOut: boolean;
  lastMessage: string;
  lastDirection: "inbound" | "outbound";
  lastAt: string;
  unread: number;
  windowOpen: boolean;
};

const POLL_MS = 15_000;

/// "14:32" today, "Yesterday", else "12 Aug" — the WhatsApp-list convention.
function stamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).format(d);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(d);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function WhatsAppInbox({
  initial,
  selectedLeadId,
}: {
  initial: ConversationRow[];
  selectedLeadId: string | null;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<ConversationRow[]>(initial);
  const [query, setQuery] = useState("");
  const [, startTransition] = useTransition();
  // Locally cleared badges: the server list is polled, so without this the badge
  // would flicker back for one cycle after opening a chat.
  const clearedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/whatsapp/conversations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { conversations: ConversationRow[] };
      setRows(
        (data.conversations ?? []).map((c) =>
          clearedRef.current.has(c.leadId) ? { ...c, unread: 0 } : c,
        ),
      );
    } catch {
      /* transient — the next poll retries */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), POLL_MS);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onVis);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      window.removeEventListener("focus", onVis);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // Opening a conversation catches it up. Runs for whatever is selected, including
  // a direct link into /whatsapp?lead=…, and again when new messages land in it.
  const selectedUnread = rows.find((r) => r.leadId === selectedLeadId)?.unread ?? 0;
  useEffect(() => {
    if (!selectedLeadId) return;
    clearedRef.current.add(selectedLeadId);
    // Through a timer so the effect body itself doesn't set state.
    const t = setTimeout(() => {
      setRows((prev) => prev.map((r) => (r.leadId === selectedLeadId ? { ...r, unread: 0 } : r)));
      void readConversation(selectedLeadId);
    }, 0);
    return () => clearTimeout(t);
  }, [selectedLeadId, selectedUnread]);

  function open(leadId: string) {
    clearedRef.current.add(leadId);
    setRows((prev) => prev.map((r) => (r.leadId === leadId ? { ...r, unread: 0 } : r)));
    startTransition(() => router.push(`/whatsapp?lead=${leadId}`));
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.phone.replace(/\s/g, "").includes(q.replace(/\s/g, "")) ||
        r.lastMessage.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totalUnread = rows.reduce((n, r) => n + r.unread, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b-[0.5px] border-cara-rule px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Chats</h2>
          {totalUnread > 0 && (
            <span className="rounded-full bg-green-600 px-2 py-0.5 text-[11px] font-semibold text-white">
              {totalUnread} new
            </span>
          )}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, number or message…"
          className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-1.5 text-sm dark:border-white/15"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-cara-muted">
            {rows.length === 0 ? "No WhatsApp conversations yet." : "No chat matches that search."}
          </p>
        ) : (
          filtered.map((r) => {
            const active = r.leadId === selectedLeadId;
            return (
              <button
                key={r.leadId}
                onClick={() => open(r.leadId)}
                className={`flex w-full items-start gap-3 border-b-[0.5px] border-cara-rule px-3 py-3 text-left transition-colors ${
                  active ? "bg-cara-surface" : "hover:bg-cara-surface/60"
                }`}
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-green-600/15 text-xs font-semibold text-green-800 dark:text-green-300">
                  {initials(r.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm ${r.unread > 0 ? "font-semibold" : "font-medium"}`}>
                      {r.name}
                    </span>
                    <span
                      suppressHydrationWarning
                      className={`shrink-0 text-[10px] ${r.unread > 0 ? "text-green-700 dark:text-green-400" : "text-cara-muted"}`}
                    >
                      {stamp(r.lastAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className={`truncate text-xs ${r.unread > 0 ? "text-cara-ink" : "text-cara-muted"}`}>
                      {r.lastDirection === "outbound" ? "You: " : ""}
                      {r.lastMessage}
                    </span>
                    {r.unread > 0 && (
                      <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-green-600 px-1 text-[10px] font-semibold text-white">
                        {r.unread > 9 ? "9+" : r.unread}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[10px] text-cara-muted">
                    {r.optedOut ? (
                      <span className="text-red-600 dark:text-red-400">opted out</span>
                    ) : r.windowOpen ? (
                      <span className="text-green-700 dark:text-green-400">24h window open</span>
                    ) : (
                      <span>window closed</span>
                    )}
                    {r.ownerName ? <span>· {r.ownerName}</span> : null}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
