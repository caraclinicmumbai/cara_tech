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
        className="txt-good rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
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
        className="txt-bad rounded px-2 py-1 text-xs font-medium disabled:opacity-50"
      >
        Delete permanently
      </button>
      )}
    </span>
  );
}
