"use client";

// Step through the leads the telecaller filtered down to (§leads table).
//
// Appears only when this lead was opened from a filtered list — the queue is captured
// on the way in (lib/leadQueue.ts). Opened from a search, a bell or a pasted link,
// there's nothing to step through and nothing is shown.
//
// Rendered after mount rather than server-side: the queue lives in sessionStorage, which
// the server can't see. That means one frame without it, which is the right trade for
// keeping the queue per-tab and off the URL.
import { useSyncExternalStore } from "react";
import Link from "next/link";
import {
  clearLeadQueue,
  positionIn,
  subscribeLeadQueue,
  getLeadQueueSnapshot,
  getLeadQueueServerSnapshot,
} from "@/lib/leadQueue";

export function LeadQueueNav({ leadId }: { leadId: string }) {
  // sessionStorage is external state the server can't see, so it's read the way React
  // wants external state read — not via an effect that sets state on mount.
  const queue = useSyncExternalStore(
    subscribeLeadQueue,
    getLeadQueueSnapshot,
    getLeadQueueServerSnapshot,
  );

  const pos = positionIn(queue, leadId);
  if (!pos) return null;

  const btn =
    "inline-flex items-center gap-1 rounded-lg border border-cara-rule px-2.5 py-1 text-[13px] text-cara-ink transition-colors hover:bg-cara-surface-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cara-rule bg-cara-surface-2 px-3 py-2">
      <span className="text-[12px] text-cara-muted">
        Lead <span className="font-semibold text-cara-ink">{pos.index + 1}</span> of {pos.total}
        <span className="ml-1.5 text-cara-faint">· {queue!.label}</span>
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        {pos.prevId ? (
          <Link href={`/leads/${pos.prevId}`} className={btn} aria-label="Previous lead in this list">
            ← Prev
          </Link>
        ) : (
          <button type="button" className={btn} disabled aria-label="No previous lead">
            ← Prev
          </button>
        )}

        {pos.nextId ? (
          // The one telecallers actually use, so it's the emphasised control.
          <Link
            href={`/leads/${pos.nextId}`}
            className={`${btn} border-cara-ink bg-cara-ink font-medium text-cara-page hover:bg-cara-ink-soft`}
            aria-label="Next lead in this list"
          >
            Next lead →
          </Link>
        ) : (
          <span className="text-[12px] text-cara-faint">End of the list</span>
        )}

        <button
          type="button"
          onClick={clearLeadQueue}
          className="rounded px-1.5 py-1 text-[12px] text-cara-muted hover:text-cara-ink"
          aria-label="Stop stepping through this list"
          title="Stop stepping through this list"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
