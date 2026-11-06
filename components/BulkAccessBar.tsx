"use client";

// Grant or revoke a colleague's access across many leads (§handover), with the same options
// as the single-lead panel: who, how long, why. Shown above the leads table to whoever holds
// `leads.grantAccess`. Access never changes who owns the lead.
import { useState, useTransition } from "react";
import { bulkLeadAccessAction } from "@/app/(dashboard)/leads/ownershipActions";

const DURATIONS = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "Until revoked", days: 0 },
];

const inputCls = "rounded border border-black/15 bg-background px-2 py-1 text-sm dark:border-white/20";

export function BulkAccessBar({
  count,
  grantees,
  scopeLabel,
  target,
  onDone,
}: {
  count: number;
  grantees: { id: string; label: string }[];
  scopeLabel: string;
  target: { leadIds: string[] } | { query: string };
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [grantee, setGrantee] = useState("");
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState("");
  const leads = `${count.toLocaleString("en-IN")} lead${count === 1 ? "" : "s"}`;
  const who = grantees.find((g) => g.id === grantee)?.label ?? "";

  function run(action: "grant" | "revoke") {
    const verb = action === "grant" ? `Give ${who} access to` : `Remove ${who}'s access to`;
    if (!window.confirm(`${verb} ${leads}?`)) return;
    startTransition(async () => {
      const res = await bulkLeadAccessAction({
        action,
        ...target,
        scopeLabel,
        granteeUserId: grantee,
        reason: reason || null,
        durationDays: days || null,
      });
      if (!res.ok) {
        window.alert(res.error ?? "Could not change access");
        return;
      }
      window.alert(
        action === "grant"
          ? `Access granted on ${res.done} lead(s).${res.skipped ? ` ${res.skipped} already had it.` : ""}`
          : `Access removed from ${res.done} lead(s).`,
      );
      setReason("");
      onDone();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-black/10 px-2 py-1.5 dark:border-white/15">
      <span className="font-medium">{leads}</span>
      <select className={inputCls} value={grantee} aria-label="Colleague" onChange={(e) => setGrantee(e.target.value)}>
        <option value="">Colleague…</option>
        {grantees.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
      </select>
      <select className={inputCls} value={days} aria-label="For how long" onChange={(e) => setDays(Number(e.target.value))}>
        {DURATIONS.map((d) => <option key={d.days} value={d.days}>{d.label}</option>)}
      </select>
      <input className={inputCls} placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button
        type="button"
        disabled={pending || !grantee}
        onClick={() => run("grant")}
        className="rounded bg-foreground px-3 py-1 text-sm font-medium text-background disabled:opacity-50"
      >
        {pending ? "Working…" : "Grant access"}
      </button>
      <button
        type="button"
        disabled={pending || !grantee}
        onClick={() => run("revoke")}
        className="txt-bad text-sm hover:underline disabled:opacity-50"
      >
        Revoke
      </button>
    </div>
  );
}
