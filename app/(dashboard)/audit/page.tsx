import { requireCapability } from "@/lib/authz";
import { listAuditLog } from "@/lib/audit";
import { AuditTable } from "@/components/AuditTable";
import { AuditVerifyButton } from "@/components/AuditVerifyButton";

export const dynamic = "force-dynamic";

// Compliance audit log (§compliance). Route-guarded to `audit.view` in the proxy;
// re-checked here. Filters (action, actor, date range) are plain GET params so it works
// without client JS and every view is a shareable URL.
const ACTIONS: { value: string; label: string }[] = [
  { value: "", label: "All events" },
  { value: "lead.", label: "All lead events" },
  { value: "lead.field.update", label: "Field changes" },
  { value: "lead.stage.move", label: "Stage moves" },
  { value: "lead.consent.change", label: "Consent changes" },
  { value: "lead.handover", label: "Handovers" },
  { value: "lead.assign", label: "Assignments" },
  { value: "lead.access.grant", label: "Access grants" },
  { value: "lead.access.revoke", label: "Access revokes" },
  { value: "lead.merge", label: "Merges" },
  { value: "lead.softDelete", label: "Deletions" },
  { value: "lead.export", label: "Data exports" },
  { value: "record.view", label: "Record views" },
  { value: "auth.login", label: "Logins" },
  { value: "auth.login.failed", label: "Failed logins" },
  { value: "auth.logout", label: "Logouts" },
  { value: "settings.", label: "Settings changes" },
  { value: "role.permissions.change", label: "Role permission changes" },
];

const inputCls = "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string; from?: string; to?: string; entityId?: string }>;
}) {
  await requireCapability("audit.view");
  const sp = await searchParams;

  const from = sp.from ? new Date(`${sp.from}T00:00:00`) : undefined;
  const to = sp.to ? new Date(`${sp.to}T23:59:59`) : undefined;
  const entries = await listAuditLog({
    action: sp.action || undefined,
    actorEmail: sp.actor || undefined,
    entityId: sp.entityId || undefined,
    from: from && !isNaN(from.getTime()) ? from : undefined,
    to: to && !isNaN(to.getTime()) ? to : undefined,
    take: 300,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Every recorded event — record views, logins, field edits, stage moves, consent
          changes, reassignments, settings changes, and data exports — with who, when, from
          where, and why. Entries are append-only (immutable at the database) and
          hash-chained so tampering is detectable.
        </p>
      </div>

      <div className="rounded border border-black/10 p-3 dark:border-white/15">
        <AuditVerifyButton />
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2 rounded border border-black/10 p-3 dark:border-white/15">
        <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
          Event type
          <select name="action" defaultValue={sp.action ?? ""} className={inputCls}>
            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
          Actor (email contains)
          <input name="actor" defaultValue={sp.actor ?? ""} placeholder="e.g. admin@" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
          Lead ID (optional)
          <input name="entityId" defaultValue={sp.entityId ?? ""} placeholder="lead id" className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
          From
          <input type="date" name="from" defaultValue={sp.from ?? ""} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-black/50 dark:text-white/50">
          To
          <input type="date" name="to" defaultValue={sp.to ?? ""} className={inputCls} />
        </label>
        <button type="submit" className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background">Filter</button>
        <a href="/audit" className="rounded border border-black/15 px-3 py-1.5 text-sm dark:border-white/20">Clear</a>
      </form>

      <div className="space-y-2">
        <p className="text-sm text-black/50 dark:text-white/50">{entries.length} record{entries.length === 1 ? "" : "s"} (most recent 300)</p>
        <AuditTable entries={entries} showEntity />
      </div>
    </div>
  );
}
