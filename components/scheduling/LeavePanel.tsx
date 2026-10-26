"use client";

// Leave & availability (§2.9): request my leave, approve / reject requests, enter
// leave for someone, mark a same-day emergency, and the list of upcoming leave.
import { useEffect, useState } from "react";
import {
  cancelLeaveEntry,
  decideLeaveRequest,
  enterLeaveFor,
  markDoctorEmergency,
  previewLeave,
  requestMyLeave,
} from "@/app/(dashboard)/appointments/leave/actions";
import { Msg, useRun } from "./useRun";

export type LeaveRow = {
  id: string;
  resourceName: string;
  kind: string;
  status: string;
  from: string;
  to: string;
  reason: string | null;
  affected: number;
  mine: boolean;
};

type Opt = { id: string; name: string };

function LeaveForm({
  people,
  kinds,
  submit,
  label,
}: {
  people: Opt[] | null; // null = for myself
  kinds: { key: string; label: string }[];
  submit: (f: { resourceId: string; start: string; end: string; kind: string; reason: string }) => Promise<{ ok: boolean; error?: string; info?: string }>;
  label: string;
}) {
  const empty = { resourceId: people?.[0]?.id ?? "", start: "", end: "", kind: "leave", reason: "" };
  const [f, setF] = useState(empty);
  const [preview, setPreview] = useState<{ key: string; n: number } | null>(null);
  const { run, pending, msg } = useRun();
  const key = `${f.resourceId}|${f.start}|${f.end}`;

  useEffect(() => {
    if (!people || !f.resourceId || !f.start) return;
    let live = true;
    previewLeave(f.resourceId, f.start, f.end).then((n) => live && setPreview({ key, n }));
    return () => {
      live = false;
    };
  }, [people, f.resourceId, f.start, f.end, key]);
  const affected = preview?.key === key ? preview.n : null;

  return (
    <div className="cara-card space-y-3 p-5">
      <div className="font-medium text-cara-ink">{label}</div>
      <div className="flex flex-wrap items-center gap-2">
        {people && (
          <select className="cara-select w-auto!" value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })} aria-label="Doctor / staff">
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        <select className="cara-select w-auto!" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Type">
          {kinds.filter((k) => k.key !== "emergency").map((k) => (
            <option key={k.key} value={k.key}>{k.label}</option>
          ))}
        </select>
        <input type="date" className="cara-input w-auto!" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label="From" />
        <span className="text-[12px] text-cara-muted">to</span>
        <input type="date" className="cara-input w-auto!" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} aria-label="To" />
        <input className="cara-input min-w-[12rem]! flex-1" placeholder="Reason (e.g. hair-restoration conference, Dubai)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
      {affected !== null && (
        <p className={`text-[12px] ${affected ? "txt-warn" : "text-cara-muted"}`}>
          {affected ? `${affected} booked appointment(s) fall inside this — they'll go to Needs rebooking.` : "No booked appointments inside this."}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => submit(f), () => setF(empty))}>
          {people ? "Save (approved)" : "Request leave"}
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

function Emergency({ people }: { people: Opt[] }) {
  const [f, setF] = useState({ resourceId: people[0]?.id ?? "", reason: "" });
  const { run, pending, msg } = useRun();
  return (
    <div className="cara-card space-y-3 border-l-4 border-l-[#ef5b3c] p-5">
      <div className="font-medium text-cara-ink">Emergency — unavailable for the rest of today</div>
      <p className="cara-note text-[12px]">
        Blocks them at every branch from now until midnight. Today&rsquo;s appointments go to Needs rebooking as urgent, and admins and the
        Sales Head are alerted at once.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="cara-select w-auto!" value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })} aria-label="Doctor">
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input className="cara-input min-w-[12rem]! flex-1" placeholder="Reason * (e.g. unwell)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <button
          className="cara-btn cara-btn-danger"
          disabled={pending || !f.reason.trim()}
          onClick={() => {
            if (confirm("Mark unavailable for the rest of today? Admins and the Sales Head will be alerted.")) run(() => markDoctorEmergency(f.resourceId, f.reason), () => setF({ ...f, reason: "" }));
          }}
        >
          Mark unavailable now
        </button>
      </div>
      <Msg msg={msg} />
    </div>
  );
}

function Row({ r, canApprove, canCancel }: { r: LeaveRow; canApprove: boolean; canCancel: boolean }) {
  const { run, pending, msg } = useRun();
  const [note, setNote] = useState("");
  return (
    <div className="cara-card space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-cara-ink">{r.resourceName}</span>
        <span className="tag tag-ink">{r.kind}</span>
        <span className={`tag ${r.status === "requested" ? "tag-citric" : "tag-aqua"}`}>{r.status === "requested" ? "awaiting approval" : "approved"}</span>
        <span className="text-[12.5px] text-cara-muted">{r.from} → {r.to}</span>
        {r.affected > 0 && <span className="text-[12px] txt-warn">· {r.affected} appointment(s) inside</span>}
      </div>
      {r.reason && <div className="text-[12.5px]">{r.reason}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {canApprove && r.status === "requested" && (
          <>
            <input className="cara-input w-64!" placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => decideLeaveRequest(r.id, true, note))}>Approve</button>
            <button className="cara-btn" disabled={pending} onClick={() => run(() => decideLeaveRequest(r.id, false, note))}>Reject</button>
          </>
        )}
        {(canCancel || r.mine) && (
          <button className="cara-btn" disabled={pending} onClick={() => confirm("Withdraw this leave?") && run(() => cancelLeaveEntry(r.id))}>
            Withdraw
          </button>
        )}
        <Msg msg={msg} />
      </div>
    </div>
  );
}

export function LeavePanel({
  leave,
  myName,
  isManager,
  canApprove,
  people,
  kinds,
}: {
  leave: LeaveRow[];
  myName: string | null;
  isManager: boolean;
  canApprove: boolean;
  people: Opt[];
  kinds: { key: string; label: string }[];
}) {
  const pending = leave.filter((l) => l.status === "requested");
  const approved = leave.filter((l) => l.status === "approved");
  return (
    <div className="space-y-6">
      {myName && (
        <LeaveForm
          people={null}
          kinds={kinds}
          label={`Request leave for ${myName}`}
          submit={(f) => requestMyLeave({ start: f.start, end: f.end, kind: f.kind, reason: f.reason })}
        />
      )}
      {isManager && (
        <>
          <LeaveForm people={people} kinds={kinds} label="Enter leave for a doctor / staff member" submit={enterLeaveFor} />
          {people.length > 0 && <Emergency people={people} />}
        </>
      )}
      {!myName && !isManager && (
        <div className="cara-notice is-info">Your login isn&rsquo;t linked to a doctor or staff calendar, so there&rsquo;s no leave to request here.</div>
      )}

      <section className="space-y-3">
        <h2 className="cara-eyebrow">Awaiting approval ({pending.length})</h2>
        {pending.length === 0 && <p className="cara-note">Nothing waiting.</p>}
        {pending.map((r) => (
          <Row key={r.id} r={r} canApprove={canApprove} canCancel={isManager} />
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="cara-eyebrow">Upcoming approved leave ({approved.length})</h2>
        {approved.length === 0 && <p className="cara-note">None.</p>}
        {approved.map((r) => (
          <Row key={r.id} r={r} canApprove={false} canCancel={isManager} />
        ))}
      </section>
    </div>
  );
}
