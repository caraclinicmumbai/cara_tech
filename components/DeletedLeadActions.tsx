"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreLead, permanentlyDeleteLead } from "@/app/(dashboard)/leads/actions";

// Restore or permanently remove a soft-deleted lead. Used on the Deleted page.
export function DeletedLeadActions({
  leadId,
  name,
  canPurge = false,
}: {
  leadId: string;
  name: string;
  canPurge?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <span className="inline-flex gap-2">
      <button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await restoreLead(leadId);
            if (res.ok) router.refresh();
            else window.alert(res.error ?? "Restore failed");
          })
        }
        className="rounded px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-600/10 disabled:opacity-50 dark:text-green-400"
      >
        ↩ Restore
      </button>
      {canPurge && (
      <button
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Permanently delete "${name}"? This removes the lead and its calls/messages for good — it cannot be undone.`,
            )
          )
            return;
          startTransition(async () => {
            const res = await permanentlyDeleteLead(leadId);
            if (res.ok) router.refresh();
            else window.alert(res.error ?? "Delete failed");
          });
        }}
        className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
      >
        Delete permanently
      </button>
      )}
    </span>
  );
}
