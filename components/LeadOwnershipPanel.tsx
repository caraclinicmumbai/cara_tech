"use client";

// Lead ownership & access (§handover). Shows the current owner, a hand-over control
// (transfer ownership — cross-branch needs a reason), a grant-access control (managers
// let a colleague act on the lead without owning it), the active grants, and a
// chronological history of every handover/grant/revoke.
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  handoverLeadAction,
  grantLeadAccessAction,
  revokeLeadAccessAction,
} from "@/app/(dashboard)/leads/ownershipActions";

type Rep = { id: string; name: string; branchId: string | null; branchName: string | null };
type UserOpt = { id: string; label: string };
type ActiveGrant = {
  id: string;
  granteeName: string;
  grantedByName: string | null;
  reason: string | null;
  expiresAt: string | null;
  createdAt: string;
};
type Timeline = {
  id: string;
  at: string;
  action: string;
  actorEmail: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
};

const inputCls = "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

function ist(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}

const DURATIONS = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "Until revoked", days: 0 },
];

export function LeadOwnershipPanel({
  leadId,
  ownerName,
  ownerRepId,
  ownerBranchId,
  reps,
  users,
  activeGrants,
  history,
  canHandover,
  canGrant,
}: {
  leadId: string;
  ownerName: string;
  ownerRepId: string | null;
  ownerBranchId: string | null;
  reps: Rep[];
  users: UserOpt[];
  activeGrants: ActiveGrant[];
  history: Timeline[];
  canHandover: boolean;
  canGrant: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Set once the handover has cost this user their access to the lead — the rest of
  // the page is now stale and a refresh would 404, so we swap in a confirmation.
  const [handedTo, setHandedTo] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else window.alert(res.error ?? "Action failed");
    });

  const [toRep, setToRep] = useState("");
  const [hReason, setHReason] = useState("");
  const [grantee, setGrantee] = useState("");
  const [gReason, setGReason] = useState("");
  const [days, setDays] = useState(3);

  // Cross-branch hint: selected rep's branch differs from the owner's (both known).
  const selRep = reps.find((r) => r.id === toRep);
  const crossBranch = !!ownerBranchId && !!selRep?.branchId && selRep.branchId !== ownerBranchId;

  const historyLine = (t: Timeline) => {
    if (t.action === "lead.handover")
      return { icon: "🔁", text: `Handover — ${t.oldValue ?? "?"} → ${t.newValue ?? "?"}` };
    if (t.action === "lead.access.grant")
      return { icon: "🔓", text: `Access granted to ${t.newValue ?? "?"}` };
    if (t.action === "lead.access.revoke")
      return { icon: "🔒", text: `Access revoked for ${t.oldValue ?? "?"}` };
    return { icon: "•", text: t.action };
  };

  // The transfer went through and took this user's access with it. Refreshing here
  // would land them on a 404 of a lead they just gave away, so confirm what happened
  // and point them back to their list. (Reloading the page shows the same message —
  // the lead page recognises the previous owner; see recentHandoverForViewer.)
  if (handedTo) {
    return (
      <div className="space-y-3 rounded border border-black/10 p-4 text-center dark:border-white/15">
        <div className="text-3xl">🔁</div>
        <p className="text-sm font-medium">This lead is now with {handedTo}</p>
        <p className="text-sm text-black/55 dark:text-white/55">
          They&apos;ve been notified. It has left your list, so you can no longer open it —
          ask a manager if you need it back.
        </p>
        <Link
          href="/leads"
          className="inline-block rounded bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Back to leads
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded border border-black/10 p-4 dark:border-white/15">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-black/50 dark:text-white/50">Owner</span>
        <span className="font-medium">{ownerName}</span>
      </div>

      {/* ── Hand over (transfer ownership) ── */}
      {canHandover && (
        <div className="space-y-2 border-t border-black/10 pt-3 dark:border-white/15">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">Hand over</div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputCls} value={toRep} onChange={(e) => setToRep(e.target.value)}>
              <option value="">Hand to counsellor…</option>
              {reps.filter((r) => r.id !== ownerRepId).map((r) => (
                <option key={r.id} value={r.id}>{r.name}{r.branchName ? ` · ${r.branchName}` : ""}</option>
              ))}
            </select>
            <input className={`${inputCls} min-w-[14rem] flex-1`} placeholder={crossBranch ? "Reason (required — cross-branch)" : "Reason (optional)"}
              value={hReason} onChange={(e) => setHReason(e.target.value)} />
            <button
              disabled={pending || !toRep || (crossBranch && !hReason.trim())}
              className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
              onClick={() =>
                startTransition(async () => {
                  const res = await handoverLeadAction({ leadId, toRepId: toRep, reason: hReason || null });
                  if (!res.ok) {
                    window.alert(res.error ?? "Action failed");
                    return;
                  }
                  setToRep("");
                  setHReason("");
                  // Only refresh while we can still read the lead; otherwise show the
                  // confirmation rather than reloading into a not-found page.
                  if (res.lostAccess) setHandedTo(res.toRepName ?? "another counsellor");
                  else router.refresh();
                })
              }
            >
              Hand over
            </button>
          </div>
          {crossBranch && (
            <p className="text-xs text-amber-700 dark:text-amber-400">Cross-branch handover — a written reason is required.</p>
          )}
        </div>
      )}

      {/* ── Grant temporary access (no ownership change) ── */}
      {canGrant && (
        <div className="space-y-2 border-t border-black/10 pt-3 dark:border-white/15">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">Grant temporary access</div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputCls} value={grantee} onChange={(e) => setGrantee(e.target.value)}>
              <option value="">Grant to…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
            <select className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DURATIONS.map((d) => <option key={d.days} value={d.days}>{d.label}</option>)}
            </select>
            <input className={`${inputCls} min-w-[14rem] flex-1`} placeholder="Reason (e.g. covering while on leave)"
              value={gReason} onChange={(e) => setGReason(e.target.value)} />
            <button
              disabled={pending || !grantee}
              className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
              onClick={() => run(() => grantLeadAccessAction({ leadId, granteeUserId: grantee, reason: gReason || null, durationDays: days || null }).then((r) => { if (r.ok) { setGrantee(""); setGReason(""); } return r; }))}
            >
              Grant access
            </button>
          </div>
        </div>
      )}

      {/* ── Active grants ── */}
      {activeGrants.length > 0 && (
        <div className="space-y-2 border-t border-black/10 pt-3 dark:border-white/15">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">Active access ({activeGrants.length})</div>
          <ul className="space-y-1.5">
            {activeGrants.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                <span className="font-medium">{g.granteeName}</span>
                <span className="text-xs text-black/50 dark:text-white/50">
                  {g.expiresAt ? `until ${ist(g.expiresAt)}` : "until revoked"}
                  {g.grantedByName ? ` · by ${g.grantedByName}` : ""}
                  {g.reason ? ` · ${g.reason}` : ""}
                </span>
                {canGrant && (
                  <button disabled={pending} className="text-xs text-red-600 hover:underline dark:text-red-400"
                    onClick={() => run(() => revokeLeadAccessAction({ grantId: g.id, leadId }))}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── History ── */}
      <div className="space-y-2 border-t border-black/10 pt-3 dark:border-white/15">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">History</div>
        {history.length === 0 ? (
          <p className="text-xs text-black/45 dark:text-white/45">No handovers or access changes yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((t) => {
              const { icon, text } = historyLine(t);
              return (
                <li key={t.id} className="flex gap-2 text-sm">
                  <span aria-hidden>{icon}</span>
                  <div className="min-w-0">
                    <div>{text}</div>
                    <div className="text-xs text-black/45 dark:text-white/45">
                      {ist(t.at)}{t.actorEmail ? ` · by ${t.actorEmail}` : ""}{t.reason ? ` · “${t.reason}”` : ""}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
