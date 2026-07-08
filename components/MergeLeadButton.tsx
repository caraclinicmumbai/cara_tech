"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mergeDuplicateLead } from "@/app/(dashboard)/leads/actions";

// Merges this duplicate lead into its original, then navigates to the survivor.
export function MergeLeadButton({
  leadId,
  originalName,
}: {
  leadId: string;
  originalName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => {
          if (
            !window.confirm(
              `Merge this lead into "${originalName}"? Its calls and messages move over, and this duplicate record is deleted. This can't be undone.`,
            )
          )
            return;
          startTransition(async () => {
            setError(null);
            const res = await mergeDuplicateLead(leadId);
            if (res.ok) {
              router.push(`/leads/${res.originalId}`);
              router.refresh();
            } else {
              setError(res.error);
            }
          });
        }}
        disabled={pending}
        className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {pending ? "Merging…" : `Merge into ${originalName}`}
      </button>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
