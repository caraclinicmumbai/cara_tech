"use client";

import { useTransition } from "react";
import { LEAD_STAGES, STAGE_LABELS } from "@/lib/leadStages";
import { setLeadStage } from "@/app/(dashboard)/leads/actions";

// Inline pipeline-stage dropdown. Saves on change via the setLeadStage action;
// the page revalidates so the new value sticks across navigations.
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

  return (
    <select
      aria-label="Lead stage"
      value={stage}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        startTransition(() => {
          void setLeadStage(leadId, next);
        });
      }}
      className={`rounded border border-black/15 bg-transparent px-2 py-1 text-xs disabled:opacity-50 dark:border-white/20 ${className}`}
    >
      {LEAD_STAGES.map((s) => (
        <option key={s} value={s}>
          {STAGE_LABELS[s]}
        </option>
      ))}
    </select>
  );
}
