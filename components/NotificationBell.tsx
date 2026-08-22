"use client";

// The header bell (§handover). A telecaller learns about a handover here — in the
// software, not only in Slack — and the entry links straight to the lead.
//
// Polls its feed rather than holding a stream: bells are low-frequency and must
// survive the tab being backgrounded for hours, so a cheap 45s poll (paused while
// hidden, refreshed on focus) fits better than a long-lived connection.
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { readAllNotifications, readNotification } from "@/app/(dashboard)/notificationActions";
import { formatIst } from "@/lib/datetime";

type Item = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  leadId: string | null;
  read: boolean;
  createdAt: string;
};

const POLL_MS = 45_000;

export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: Item[]; unread: number };
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      /* offline or signed out — the next poll retries */
    }
  }, []);

  // Poll while the tab is visible; catch up immediately when it comes back.
  useEffect(() => {
    // First fetch goes through a timer too, so the effect body itself never sets state.
    const first = setTimeout(() => void load(), 0);
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

  // Close on an outside click, like the status switcher next to it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function openItem(item: Item) {
    setOpen(false);
    if (!item.read) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
      setUnread((n) => Math.max(0, n - 1));
      startTransition(async () => {
        await readNotification(item.id);
        router.refresh();
      });
    }
  }

  function markAll() {
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    setUnread(0);
    startTransition(async () => {
      await readAllNotifications();
      router.refresh();
    });
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        className="relative grid h-8 w-8 place-items-center rounded-xl text-cara-muted transition-colors hover:bg-cara-surface hover:text-cara-ink"
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-4.5 w-4.5" aria-hidden="true">
          <path
            d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5v2.2c0 .5-.2 1-.5 1.4L4 12h12l-1-1.4a2.2 2.2 0 0 1-.5-1.4V7A4.5 4.5 0 0 0 10 2.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M8 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-xl border-[0.5px] border-cara-rule bg-cara-page shadow-lg">
          <div className="flex items-center justify-between border-b-[0.5px] border-cara-rule px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cara-muted">
              Notifications
            </span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-cara-muted hover:text-cara-ink hover:underline">
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-cara-muted">Nothing yet.</p>
            ) : (
              items.map((item) => {
                const inner = (
                  <>
                    <div className="flex items-start gap-2">
                      {!item.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-600" />}
                      <div className="min-w-0">
                        <div className={`truncate text-sm ${item.read ? "text-cara-muted" : "font-medium text-cara-ink"}`}>
                          {item.title}
                        </div>
                        {item.body && (
                          <div className="mt-0.5 line-clamp-2 text-xs text-cara-muted">{item.body}</div>
                        )}
                        <div suppressHydrationWarning className="mt-1 text-[10px] text-cara-muted">
                          {formatIst(item.createdAt)}
                        </div>
                      </div>
                    </div>
                  </>
                );
                const className = "block w-full border-b-[0.5px] border-cara-rule px-3 py-2 text-left hover:bg-cara-surface";
                return item.leadId ? (
                  <Link key={item.id} href={`/leads/${item.leadId}`} onClick={() => openItem(item)} className={className}>
                    {inner}
                  </Link>
                ) : (
                  <button key={item.id} onClick={() => openItem(item)} className={className}>
                    {inner}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
