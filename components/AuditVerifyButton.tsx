"use client";

// "Verify integrity" — runs the hash-chain check and shows whether the audit log is
// intact or has been tampered with (§compliance).
import { useState, useTransition } from "react";
import { verifyAuditIntegrityAction } from "@/app/(dashboard)/audit/actions";
import type { ChainResult } from "@/lib/audit";

export function AuditVerifyButton() {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<ChainResult | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        disabled={pending}
        onClick={() => start(async () => setRes(await verifyAuditIntegrityAction()))}
        className="rounded border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
      >
        {pending ? "Verifying…" : "Verify integrity"}
      </button>
      {res && (
        res.ok ? (
          <span className="tag tag-aqua">
            Intact — {res.checked} entries chained &amp; unaltered
          </span>
        ) : (
          <span className="tag tag-tangerine">
            TAMPERED — broke at {res.brokenAt?.action} ({res.brokenAt?.reason}). An alert has been sent.
          </span>
        )
      )}
    </div>
  );
}
