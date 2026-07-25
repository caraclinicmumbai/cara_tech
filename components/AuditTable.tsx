// Presentational audit-log table (§compliance). Server component — renders a list of
// AuditEntry rows: what changed (action + field), old → new, who, when, and why.
// Used both on a lead's Change-history section and the global /audit screen.
import { actionLabel, type AuditEntry } from "@/lib/audit";

function ist(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}

function change(e: AuditEntry): string {
  if (e.oldValue != null && e.newValue != null) return `${e.oldValue} → ${e.newValue}`;
  if (e.newValue != null) return e.newValue;
  if (e.oldValue != null) return e.oldValue;
  return "—";
}

export function AuditTable({ entries, showEntity = false }: { entries: AuditEntry[]; showEntity?: boolean }) {
  if (entries.length === 0) {
    return <p className="text-sm text-black/45 dark:text-white/45">No matching audit records.</p>;
  }
  return (
    <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
      <table className="min-w-full text-sm">
        <thead className="bg-black/5 text-left dark:bg-white/10">
          <tr>
            <th className="px-3 py-2 whitespace-nowrap">When (IST)</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">Field</th>
            <th className="px-3 py-2">Change</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2">By</th>
            {showEntity && <th className="px-3 py-2">Entity</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-black/5 align-top dark:border-white/10">
              <td className="whitespace-nowrap px-3 py-2 text-black/60 dark:text-white/60">{ist(e.at)}</td>
              <td className="px-3 py-2 font-medium">{actionLabel(e.action)}</td>
              <td className="px-3 py-2 text-black/60 dark:text-white/60">{e.field ?? "—"}</td>
              <td className="px-3 py-2">{change(e)}</td>
              <td className="px-3 py-2 text-black/60 dark:text-white/60">{e.reason ?? "—"}</td>
              <td className="px-3 py-2 text-black/60 dark:text-white/60">{e.actorEmail ?? "system"}</td>
              {showEntity && (
                <td className="px-3 py-2 text-xs text-black/45 dark:text-white/45">
                  {e.entityType}{e.entityId ? ` · ${e.entityId.slice(-6)}` : ""}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
