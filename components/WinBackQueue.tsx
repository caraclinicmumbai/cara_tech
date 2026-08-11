"use client";

// Dead-Lead review queue (§follow-up). Lists leads Lost in the last 30 days; a Sales /
// Telecalling Head selects one or many and approves them for one more automated try
// (the dead_lead_bulk campaign). Filter by lost reason + counsellor is done server-side
// via the URL; this component owns selection + the approve action.
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { approveLeadsForRetry } from "@/app/(dashboard)/win-back/actions";
import type { LostLeadRow } from "@/lib/campaigns/winback";

type RepOption = { id: string; name: string };

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso));
}

export function WinBackQueue({
  rows,
  reasons,
  reps,
  filters,
  campaignsEnabled,
}: {
  rows: LostLeadRow[];
  reasons: string[];
  reps: RepOption[];
  filters: { reason?: string; repId?: string };
  campaignsEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectable = rows.filter((r) => !r.inCampaign);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.id)));

  const setFilter = (key: "reason" | "repId", value: string) => {
    const params = new URLSearchParams();
    const next = { ...filters, [key]: value || undefined };
    if (next.reason) params.set("reason", next.reason);
    if (next.repId) params.set("repId", next.repId);
    router.push(`/win-back${params.toString() ? `?${params}` : ""}`);
  };

  const approve = (ids: string[]) =>
    startTransition(async () => {
      const res = await approveLeadsForRetry(ids);
      if (res.enrolled > 0) setSelected(new Set());
      const msg = res.enrolled > 0 ? `Approved ${res.enrolled} lead(s) for a retry.` : "No leads approved.";
      const skips = res.skipped.length ? `\nSkipped ${res.skipped.length}: ${res.skipped.map((s) => s.reason).join(", ")}` : "";
      window.alert((res.error ? `${res.error}\n` : "") + msg + skips);
      router.refresh();
    });

  const selCls = "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

  return (
    <div className="space-y-4">
      {!campaignsEnabled && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Follow-up campaigns are turned off (<code>CAMPAIGNS_ENABLED</code> is not set). You can review the
          queue, but approvals won&apos;t enrol until the engine is enabled.
        </div>
      )}

      {/* Filters + batch action */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={selCls} value={filters.reason ?? ""} onChange={(e) => setFilter("reason", e.target.value)}>
          <option value="">All reasons</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className={selCls} value={filters.repId ?? ""} onChange={(e) => setFilter("repId", e.target.value)}>
          <option value="">All counsellors</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <div className="ml-auto">
          <button
            disabled={pending || selected.size === 0}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
            onClick={() => approve([...selected])}
          >
            Approve {selected.size > 0 ? `${selected.size} ` : ""}for retry
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
          No leads marked Lost in the last 30 days{filters.reason || filters.repId ? " for this filter" : ""}.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="px-3 py-2"><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} /></th>
                <th className="whitespace-nowrap px-4 py-2">Name</th>
                <th className="whitespace-nowrap px-4 py-2">Phone</th>
                <th className="whitespace-nowrap px-4 py-2">Lost</th>
                <th className="whitespace-nowrap px-4 py-2">Reason</th>
                <th className="whitespace-nowrap px-4 py-2">Counsellor</th>
                <th className="whitespace-nowrap px-4 py-2">Last CQS</th>
                <th className="whitespace-nowrap px-4 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(r.id)} disabled={r.inCampaign} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <Link href={`/leads/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                    {r.inCampaign && <span className="ml-2 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">in campaign</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{r.phone}</td>
                  <td className="whitespace-nowrap px-4 py-2">{fmt(r.lostAt)}</td>
                  <td className="px-4 py-2">{r.lostTag ?? r.lostReason ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2">{r.repName ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2">{r.lastCqs ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <button
                      disabled={pending || r.inCampaign}
                      className="text-xs text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
                      onClick={() => approve([r.id])}
                    >
                      Approve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
