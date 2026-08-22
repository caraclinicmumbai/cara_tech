"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mergeDuplicateLead } from "@/app/(dashboard)/leads/actions";

// Merges this duplicate lead into its original, then navigates to the survivor.
// The original's counsellor is named up front (and in the confirm), because merging
// hands the patient back to them — whoever was working THIS duplicate lets go.
export function MergeLeadButton({
  leadId,
  originalName,
  originalOwnerName,
  currentOwnerName,
}: {
  leadId: string;
  originalName: string;
  /// Who owns the ORIGINAL record — the owner the merged lead keeps. Null when the
  /// original has no counsellor, in which case this duplicate's owner carries over.
  originalOwnerName: string | null;
  /// Who owns this duplicate right now (for the "changes hands" warning).
  currentOwnerName: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Who ends up owning the patient after the merge, and whether that's a change.
  const keepsOwner = originalOwnerName ?? currentOwnerName;
  const changesHands = !!keepsOwner && !!currentOwnerName && keepsOwner !== currentOwnerName;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        onClick={() => {
          const ownerLine = keepsOwner
            ? `\n\nThe merged lead stays with ${keepsOwner}${
                changesHands ? ` — it leaves ${currentOwnerName}'s list.` : "."
              }`
            : "";
          if (
            !window.confirm(
              `Merge this lead into "${originalName}"? Its calls and messages move over, and this duplicate record is deleted. This can't be undone.${ownerLine}`,
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
      {keepsOwner ? (
        <span className="text-xs text-black/55 dark:text-white/55">
          Stays with <span className="font-medium">{keepsOwner}</span>
          {originalOwnerName ? " (owner of the original)" : " (this record's owner)"}
          {changesHands ? ` — leaves ${currentOwnerName}` : ""}
        </span>
      ) : (
        <span className="text-xs text-black/55 dark:text-white/55">
          Neither record has a counsellor — assign one after merging.
        </span>
      )}
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
