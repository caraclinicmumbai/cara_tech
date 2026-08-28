"use client";

import { useState, useTransition } from "react";
import { callLeadAndRecord } from "@/app/(dashboard)/leads/actions";

// Starts a recorded click-to-call: rings YOUR phone (the counsellor pressing the
// button, not the lead's owner), then connects the patient once you answer.
export function CallButton({ leadId }: { leadId: string }) {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() =>
          startTransition(async () => {
            setMsg(null);
            const res = await callLeadAndRecord(leadId);
            setMsg(
              res.ok
                ? {
                    ok: true,
                    text: `Ringing your phone${res.repName ? ` (${res.repName})` : ""} — answer to be connected to the patient.`,
                  }
                : { ok: false, text: res.error ?? "Failed to start call" },
            );
          })
        }
        disabled={pending}
        className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
      >
        {pending ? "Starting…" : "📞 Call & record"}
      </button>
      {msg && (
        <span className={`text-xs ${msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
