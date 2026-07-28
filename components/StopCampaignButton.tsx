"use client";

// Stop a lead's running follow-up campaign. Used on the lead-detail campaign card and in the
// /campaigns overview. Confirms first, then calls the gated server action and refreshes.
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { stopLeadCampaign } from "@/app/(dashboard)/campaigns/actions";

export function StopCampaignButton({
  leadId,
  className,
  label = "Stop campaign",
}: {
  leadId: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const onClick = () =>
    start(async () => {
      if (!window.confirm("Stop this lead's follow-up campaign? No further automated messages will be sent.")) return;
      const res = await stopLeadCampaign(leadId);
      if (!res.ok) window.alert("Nothing to stop — the lead has no active campaign.");
      router.refresh();
    });

  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className={
        className ??
        "rounded border border-black/15 px-2.5 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      }
    >
      {pending ? "Stopping…" : label}
    </button>
  );
}
