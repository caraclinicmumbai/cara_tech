"use client";

import { useState, useTransition } from "react";
import { LEAD_STAGES, STAGE_LABELS, LOST_STAGE, LOST_PRESET_TAGS } from "@/lib/leadStages";
import { setLeadStage } from "@/app/(dashboard)/leads/actions";

// Inline pipeline-stage dropdown. Saves on change via the setLeadStage action;
// the page revalidates so the new value sticks across navigations. Marking a lead
// Lost opens a modal to pick a preset tag and/or write a review.
export function StageSelect({
  leadId,
  stage,
  className = "",
}: {
  leadId: string;
  stage: string;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [lostOpen, setLostOpen] = useState(false);
  const [tag, setTag] = useState("");
  const [review, setReview] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submitStage(next: string, opts?: { lostTag?: string; reason?: string }) {
    startTransition(() => {
      void setLeadStage(leadId, next, opts);
    });
  }

  function confirmLost() {
    if (!tag && !review.trim()) {
      setError("Pick a preset tag or write a reason.");
      return;
    }
    setError(null);
    submitStage(LOST_STAGE, { lostTag: tag || undefined, reason: review.trim() || undefined });
    setLostOpen(false);
    setTag("");
    setReview("");
  }

  return (
    <>
      <select
        aria-label="Lead stage"
        value={stage}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          if (next === stage) return;
          if (next === LOST_STAGE) {
            // Open the Lost modal; the controlled <select> stays on `stage` until saved.
            setError(null);
            setTag("");
            setReview("");
            setLostOpen(true);
            return;
          }
          submitStage(next);
        }}
        className={`rounded border border-black/15 bg-cara-surface px-2 py-1 text-xs text-cara-ink disabled:opacity-50 dark:border-white/20 ${className}`}
      >
        {LEAD_STAGES.map((s) => (
          <option key={s} value={s} className="bg-cara-surface text-cara-ink">
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>

      {lostOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setLostOpen(false)}
        >
          <div
            className="w-full max-w-md space-y-3 rounded-lg border border-black/10 bg-background p-4 shadow-xl dark:border-white/15"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">Mark lead as Lost</h3>
            <div className="space-y-1">
              <label className="text-xs text-black/60 dark:text-white/60">Reason (preset)</label>
              <select
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                className="w-full rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20"
              >
                <option value="">— Select a tag —</option>
                {LOST_PRESET_TAGS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-black/60 dark:text-white/60">
                Review {tag ? "(optional)" : "(required if no tag)"}
              </label>
              <textarea
                value={review}
                onChange={(e) => setReview(e.target.value)}
                rows={3}
                placeholder="Add any context for the team…"
                className="w-full rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20"
              />
            </div>
            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setLostOpen(false)}
                className="rounded px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={confirmLost}
                disabled={pending}
                className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Mark Lost
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
