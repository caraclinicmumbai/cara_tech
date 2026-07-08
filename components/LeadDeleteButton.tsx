"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { softDeleteLead } from "@/app/(dashboard)/leads/actions";

// Moves a lead to the Deleted section (soft delete). Used in the leads table.
export function LeadDeleteButton({ leadId, name }: { leadId: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      title="Move to Deleted"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Move "${name}" to the Deleted section? You can restore it later.`)) return;
        startTransition(async () => {
          const res = await softDeleteLead(leadId);
          if (res.ok) router.refresh();
          else window.alert(res.error ?? "Delete failed");
        });
      }}
      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
    >
      {pending ? "…" : "🗑 Delete"}
    </button>
  );
}
