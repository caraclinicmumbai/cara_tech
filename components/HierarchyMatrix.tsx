"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveRolePermissions, resetRolePermissions } from "@/app/(dashboard)/hierarchy/actions";

type RoleState = {
  role: string;
  label: string;
  capabilities: string[];
  customized: boolean;
};
type Group = {
  key: string;
  label: string;
  capabilities: { key: string; label: string }[];
};

// grants[role] = Set of granted capability keys (local, editable copy).
type Grants = Record<string, Set<string>>;

function toGrants(roles: RoleState[]): Grants {
  const g: Grants = {};
  for (const r of roles) g[r.role] = new Set(r.capabilities);
  return g;
}

/// Stable signature of a grants map, to detect changes vs the server baseline.
function sig(grants: Grants, roles: RoleState[]): string {
  return roles
    .map((r) => `${r.role}:${[...grants[r.role]].sort().join(",")}`)
    .join("|");
}

export function HierarchyMatrix({ roles, groups }: { roles: RoleState[]; groups: Group[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const baseline = useMemo(() => toGrants(roles), [roles]);
  const baseSig = useMemo(() => sig(baseline, roles), [baseline, roles]);

  const [grants, setGrants] = useState<Grants>(() => toGrants(roles));

  // Re-sync local edits to the server state whenever the baseline changes (after a
  // save or reset triggers router.refresh() and new props arrive). This is React's
  // "adjust state during render when a prop changes" pattern — cheaper than an effect
  // and avoids the extra commit/repaint.
  const [syncedSig, setSyncedSig] = useState(baseSig);
  if (syncedSig !== baseSig) {
    setSyncedSig(baseSig);
    setGrants(toGrants(roles));
  }

  const dirtyRoles = roles
    .filter((r) => [...grants[r.role]].sort().join(",") !== [...baseline[r.role]].sort().join(","))
    .map((r) => r.role);
  const dirty = dirtyRoles.length > 0;

  const toggle = (role: string, cap: string) => {
    setGrants((prev) => {
      const next = new Set(prev[role]);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return { ...prev, [role]: next };
    });
  };

  const saveAll = () => {
    startTransition(async () => {
      for (const role of dirtyRoles) {
        const res = await saveRolePermissions(role, [...grants[role]]);
        if (!res.ok) {
          window.alert(res.error ?? "Save failed");
          return;
        }
      }
      router.refresh();
    });
  };

  const discard = () => setGrants(toGrants(roles));

  const resetRole = (role: string, label: string) => {
    if (!window.confirm(`Reset ${label} to the built-in default access?`)) return;
    startTransition(async () => {
      const res = await resetRolePermissions(role);
      if (!res.ok) {
        window.alert(res.error ?? "Reset failed");
        return;
      }
      router.refresh();
    });
  };

  const cellBusy = pending;

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3 rounded border border-black/10 bg-black/[0.02] px-3 py-2 dark:border-white/15 dark:bg-white/[0.03]">
        <span className="text-sm text-black/70 dark:text-white/70">
          {dirty
            ? `${dirtyRoles.length} role${dirtyRoles.length > 1 ? "s" : ""} with unsaved changes`
            : "All changes saved"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            disabled={!dirty || cellBusy}
            onClick={discard}
            className="rounded border border-black/15 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-white/20"
          >
            Discard
          </button>
          <button
            disabled={!dirty || cellBusy}
            onClick={saveAll}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-40"
          >
            {cellBusy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-black/5 text-left dark:bg-white/10">
              <th className="sticky left-0 z-10 bg-black/5 px-3 py-2 font-medium dark:bg-[#1a1a1a]">
                Capability
              </th>
              {roles.map((r) => (
                <th key={r.role} className="px-3 py-2 text-center align-bottom">
                  <div className="font-medium">{r.label}</div>
                  <div className="mt-0.5 text-[11px] font-normal text-black/45 dark:text-white/45">
                    {r.customized ? "customized" : "default"}
                  </div>
                  <button
                    disabled={cellBusy || !r.customized}
                    onClick={() => resetRole(r.role, r.label)}
                    className="mt-1 text-[11px] text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
                    title="Revert this role to built-in defaults"
                  >
                    Reset
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <GroupRows
                key={group.key}
                group={group}
                roles={roles}
                grants={grants}
                busy={cellBusy}
                onToggle={toggle}
                colSpan={roles.length + 1}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({
  group,
  roles,
  grants,
  busy,
  onToggle,
  colSpan,
}: {
  group: Group;
  roles: RoleState[];
  grants: Grants;
  busy: boolean;
  onToggle: (role: string, cap: string) => void;
  colSpan: number;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={colSpan}
          className="bg-black/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-black/50 dark:bg-white/[0.04] dark:text-white/50"
        >
          {group.label}
        </td>
      </tr>
      {group.capabilities.map((cap) => (
        <tr key={cap.key} className="border-t border-black/5 dark:border-white/10">
          <td className="sticky left-0 z-10 bg-background px-3 py-2">
            <span>{cap.label}</span>
            <span className="ml-2 text-[11px] text-black/35 dark:text-white/35">{cap.key}</span>
          </td>
          {roles.map((r) => (
            <td key={r.role} className="px-3 py-2 text-center">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-current disabled:cursor-not-allowed"
                checked={grants[r.role].has(cap.key)}
                disabled={busy}
                onChange={() => onToggle(r.role, cap.key)}
                aria-label={`${cap.label} for ${r.label}`}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
