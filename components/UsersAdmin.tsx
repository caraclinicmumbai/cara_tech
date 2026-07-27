"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createUser,
  setUserRole,
  setUserRep,
  setUserBranch,
  setRepBranch,
  resetUserPassword,
  deleteUser,
  createRep,
  setRepActive,
  setRepSalesHead,
  setRepSpeciality,
} from "@/app/(dashboard)/users/actions";
import { availabilityMeta } from "@/lib/presenceStatus";

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  salesRepId: string | null;
  branchId: string | null;
};
type RepRow = {
  id: string;
  name: string;
  phone: string;
  slackUserId: string | null;
  active: boolean;
  salesHead: boolean;
  branchId: string | null;
  speciality: string | null;
  availability: string;
  userEmail: string | null;
};
type Opt = { value: string; label: string };
type BranchOpt = { id: string; label: string };

const inputCls =
  "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

export function UsersAdmin({
  users,
  reps,
  roleOptions,
  branchOptions,
}: {
  users: UserRow[];
  reps: RepRow[];
  roleOptions: Opt[];
  branchOptions: BranchOpt[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = () => router.refresh();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) refresh();
      else window.alert(res.error ?? "Action failed");
    });

  // New-login form state
  const [nu, setNu] = useState({ email: "", name: "", password: "", role: "telecaller", salesRepId: "" });
  // New-rep form state
  const [nr, setNr] = useState({ name: "", phone: "", slackUserId: "", speciality: "", salesHead: false });

  const repLabel = (r: RepRow) =>
    `${r.name}${r.salesHead ? " · head" : ""}${!r.active ? " · inactive" : ""}${r.userEmail ? " · linked" : ""}`;

  return (
    <div className="space-y-10">
      {/* ── Staff logins ─────────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Staff logins ({users.length})</h2>

        <div className="flex flex-wrap items-end gap-2 rounded border border-black/10 p-3 dark:border-white/15">
          <input className={inputCls} placeholder="Email" value={nu.email}
            onChange={(e) => setNu({ ...nu, email: e.target.value })} />
          <input className={inputCls} placeholder="Name" value={nu.name}
            onChange={(e) => setNu({ ...nu, name: e.target.value })} />
          <input className={inputCls} placeholder="Temp password" value={nu.password}
            onChange={(e) => setNu({ ...nu, password: e.target.value })} />
          <select className={inputCls} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
            {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className={inputCls} value={nu.salesRepId} onChange={(e) => setNu({ ...nu, salesRepId: e.target.value })}>
            <option value="">No linked rep</option>
            {reps.map((r) => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
          </select>
          <button
            disabled={pending}
            onClick={() => run(() => createUser({ ...nu, salesRepId: nu.salesRepId || null }).then((r) => {
              if (r.ok) setNu({ email: "", name: "", password: "", role: "telecaller", salesRepId: "" });
              return r;
            }))}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          >
            Add login
          </button>
        </div>

        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Linked rep</th>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-3 py-2">{u.email}</td>
                  <td className="px-3 py-2">{u.name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <select className={inputCls} defaultValue={u.role} disabled={pending}
                      onChange={(e) => run(() => setUserRole(u.id, e.target.value))}>
                      {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select className={inputCls} defaultValue={u.salesRepId ?? ""} disabled={pending}
                      onChange={(e) => run(() => setUserRep(u.id, e.target.value || null))}>
                      <option value="">—</option>
                      {reps.map((r) => <option key={r.id} value={r.id}>{repLabel(r)}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select className={inputCls} defaultValue={u.branchId ?? ""} disabled={pending}
                      onChange={(e) => run(() => setUserBranch(u.id, e.target.value || null))}>
                      <option value="">—</option>
                      {branchOptions.map((bopt) => <option key={bopt.id} value={bopt.id}>{bopt.label}</option>)}
                    </select>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button disabled={pending} className="mr-2 text-xs text-blue-600 hover:underline dark:text-blue-400"
                      onClick={() => {
                        const p = window.prompt(`New password for ${u.email} (min 8 chars):`);
                        if (p) run(() => resetUserPassword(u.id, p));
                      }}>
                      Reset password
                    </button>
                    <button disabled={pending} className="text-xs text-red-600 hover:underline dark:text-red-400"
                      onClick={() => {
                        if (window.confirm(`Delete login ${u.email}?`)) run(() => deleteUser(u.id));
                      }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Sales-rep roster ─────────────────────────── */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Sales reps ({reps.length})</h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          Rep identities are the assignable owners: leads round-robin to <em>active</em>,
          non-sales-head reps who are <em>Active</em> right now, and handovers / click-to-call
          target them. Link a login to a rep above so a telecaller receives their leads.
          Status is live presence (counsellors set it themselves); speciality steers an
          offline counsellor&apos;s leads to a colleague with the same skill.
        </p>

        <div className="flex flex-wrap items-end gap-2 rounded border border-black/10 p-3 dark:border-white/15">
          <input className={inputCls} placeholder="Name" value={nr.name}
            onChange={(e) => setNr({ ...nr, name: e.target.value })} />
          <input className={inputCls} placeholder="Phone (+91…)" value={nr.phone}
            onChange={(e) => setNr({ ...nr, phone: e.target.value })} />
          <input className={inputCls} placeholder="Slack member ID (U…)" value={nr.slackUserId}
            onChange={(e) => setNr({ ...nr, slackUserId: e.target.value })} />
          <input className={inputCls} placeholder="Speciality (e.g. Hair)" value={nr.speciality}
            onChange={(e) => setNr({ ...nr, speciality: e.target.value })} />
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={nr.salesHead}
              onChange={(e) => setNr({ ...nr, salesHead: e.target.checked })} />
            Sales head
          </label>
          <button disabled={pending}
            onClick={() => run(() => createRep(nr).then((r) => { if (r.ok) setNr({ name: "", phone: "", slackUserId: "", speciality: "", salesHead: false }); return r; }))}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50">
            Add rep
          </button>
        </div>

        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2">Slack</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Speciality</th>
                <th className="px-3 py-2">Linked login</th>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2">Active</th>
                <th className="px-3 py-2">Sales head</th>
              </tr>
            </thead>
            <tbody>
              {reps.map((r) => (
                <tr key={r.id} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2">{r.phone || "—"}</td>
                  <td className="px-3 py-2">{r.slackUserId ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${availabilityMeta(r.availability).dot}`} aria-hidden />
                      {availabilityMeta(r.availability).label}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className={`${inputCls} w-28`}
                      defaultValue={r.speciality ?? ""}
                      placeholder="—"
                      disabled={pending}
                      onBlur={(e) => {
                        if ((e.target.value.trim() || null) !== (r.speciality ?? null))
                          run(() => setRepSpeciality(r.id, e.target.value));
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">{r.userEmail ?? "—"}</td>
                  <td className="px-3 py-2">
                    <select className={inputCls} defaultValue={r.branchId ?? ""} disabled={pending}
                      onChange={(e) => run(() => setRepBranch(r.id, e.target.value || null))}>
                      <option value="">—</option>
                      {branchOptions.map((bopt) => <option key={bopt.id} value={bopt.id}>{bopt.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={r.active} disabled={pending}
                      onChange={(e) => run(() => setRepActive(r.id, e.target.checked))} />
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={r.salesHead} disabled={pending}
                      onChange={(e) => run(() => setRepSalesHead(r.id, e.target.checked))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
