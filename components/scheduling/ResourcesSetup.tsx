"use client";

// Resources, rosters and time off (§3.2 1.4, 1.D) — the Scheduling setup "Resources &
// rosters" tab. Doctors, rooms, equipment and support staff; for people, the weekly
// roster that says where they work when, and their leave.
import { useState } from "react";
import {
  createResource,
  updateResource,
  setResourceActive,
  saveRoster,
  addTimeOff,
  deleteTimeOff,
  type ResourceInput,
  type RosterRowInput,
} from "@/app/(dashboard)/appointments/setup/actions";
import { RESOURCE_KINDS, RESOURCE_KIND_LABELS, type ResourceKind } from "@/lib/scheduling/status";
import { WEEKDAY_LABELS } from "@/lib/scheduling/time";
import { Msg, useRun } from "./useRun";

type Opt = { id: string; name: string };
type UserOpt = { id: string; label: string };

type ResourceView = {
  id: string;
  kind: string;
  subtype: string | null;
  name: string;
  branchId: string | null;
  userId: string | null;
  userLabel: string | null;
  notes: string | null;
  active: boolean;
  allowOverride: boolean;
  roster: RosterRowInput[];
  timeOff: { id: string; start: string; end: string; reason: string | null; source: string }[];
};

const SUBTYPE_HINT: Record<ResourceKind, string> = {
  doctor: "Speciality (optional)",
  room: "Room type: consultation / ot / procedure",
  equipment: "Machine type (optional)",
  staff: "Role: technician / nurse / anaesthetist",
};

const isPerson = (k: string) => k === "doctor" || k === "staff";

function ResourceFields({
  data,
  set,
  branches,
  users,
}: {
  data: ResourceInput;
  set: (p: Partial<ResourceInput>) => void;
  branches: Opt[];
  users: UserOpt[];
}) {
  const kind = data.kind as ResourceKind;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="cara-select w-auto!" value={data.kind} onChange={(e) => set({ kind: e.target.value })}>
        {RESOURCE_KINDS.map((k) => (
          <option key={k} value={k}>{RESOURCE_KIND_LABELS[k]}</option>
        ))}
      </select>
      <input className="cara-input min-w-[12rem]! flex-1" placeholder="Name *" value={data.name} onChange={(e) => set({ name: e.target.value })} />
      <input className="cara-input w-64!" placeholder={SUBTYPE_HINT[kind] ?? "Type"} value={data.subtype ?? ""} onChange={(e) => set({ subtype: e.target.value })} />
      <select className="cara-select w-auto!" value={data.branchId ?? ""} onChange={(e) => set({ branchId: e.target.value })}>
        <option value="">{isPerson(data.kind) ? "Works across branches" : "Branch *"}</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      {data.kind === "room" && (
        <label className="flex items-center gap-1.5 text-[12.5px] text-cara-muted" title="Consultation rooms only — never an OT">
          <input
            type="checkbox"
            checked={!!data.allowOverride}
            disabled={(data.subtype ?? "").trim().toLowerCase() === "ot"}
            onChange={(e) => set({ allowOverride: e.target.checked })}
          />
          branch manager may override a clash
        </label>
      )}
      {isPerson(data.kind) && (
        <select className="cara-select w-auto!" value={data.userId ?? ""} onChange={(e) => set({ userId: e.target.value })}>
          <option value="">No staff login linked</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.label}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ResourcesSetup({
  branches,
  users,
  resources,
}: {
  branches: Opt[];
  users: UserOpt[];
  resources: ResourceView[];
}) {
  const empty: ResourceInput = { kind: "doctor", name: "", subtype: "", branchId: "", userId: "" };
  const [form, setForm] = useState<ResourceInput>(empty);
  const [filter, setFilter] = useState<string>("all");
  const { run, pending, msg } = useRun();
  const shown = resources.filter((r) => filter === "all" || r.kind === filter);

  return (
    <div className="space-y-4">
      <div className="cara-card space-y-3 p-5">
        <div className="font-medium text-cara-ink">Add a resource</div>
        <ResourceFields data={form} set={(p) => setForm({ ...form, ...p })} branches={branches} users={users} />
        <div className="flex items-center gap-3">
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => createResource(form), () => setForm({ ...empty, kind: form.kind }))}>
            Add
          </button>
          <Msg msg={msg} />
        </div>
        <p className="cara-note text-[12px]">
          Rooms and equipment belong to one branch. Doctors and staff can work across branches — give them a roster to
          say where they are on which day. Someone with no roster is bookable whenever their branch is open.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {["all", ...RESOURCE_KINDS].map((k) => (
          <button key={k} className={`cara-chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
            {k === "all" ? "All" : RESOURCE_KIND_LABELS[k as ResourceKind]} ({k === "all" ? resources.length : resources.filter((r) => r.kind === k).length})
          </button>
        ))}
      </div>

      {shown.length === 0 && <p className="cara-note">Nothing here yet.</p>}
      <div className="space-y-3">
        {shown.map((r) => (
          <ResourceCard key={r.id} r={r} branches={branches} users={users} />
        ))}
      </div>
    </div>
  );
}

function ResourceCard({ r, branches, users }: { r: ResourceView; branches: Opt[]; users: UserOpt[] }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<"roster" | "timeoff" | null>(null);
  const [data, setData] = useState<ResourceInput>({
    kind: r.kind,
    name: r.name,
    subtype: r.subtype ?? "",
    branchId: r.branchId ?? "",
    userId: r.userId ?? "",
    notes: r.notes ?? "",
    allowOverride: r.allowOverride,
  });
  const { run, pending, msg } = useRun();
  const branchName = branches.find((b) => b.id === r.branchId)?.name;

  return (
    <div className={`cara-card space-y-3 p-4 ${r.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tag tag-ink">{RESOURCE_KIND_LABELS[r.kind as ResourceKind] ?? r.kind}</span>
          <span className="font-medium text-cara-ink">{r.name}</span>
          {r.subtype && <span className="text-[12px] text-cara-muted">{r.subtype}</span>}
          {r.allowOverride && <span className="tag tag-citric">override allowed</span>}
          <span className="text-[12px] text-cara-faint">· {branchName ?? "across branches"}</span>
          {r.userLabel && <span className="text-[12px] text-cara-faint">· login: {r.userLabel}</span>}
          {!r.active && <span className="tag tag-neutral">inactive</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {isPerson(r.kind) && (
            <>
              <button className={`cara-chip ${open === "roster" ? "on" : ""}`} onClick={() => setOpen(open === "roster" ? null : "roster")}>
                Roster ({r.roster.length})
              </button>
              <button className={`cara-chip ${open === "timeoff" ? "on" : ""}`} onClick={() => setOpen(open === "timeoff" ? null : "timeoff")}>
                Time off ({r.timeOff.length})
              </button>
            </>
          )}
          {!isPerson(r.kind) && (
            <button className={`cara-chip ${open === "timeoff" ? "on" : ""}`} onClick={() => setOpen(open === "timeoff" ? null : "timeoff")}>
              Downtime ({r.timeOff.length})
            </button>
          )}
          <button className="cara-btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>
          <button className="cara-btn" disabled={pending} onClick={() => run(() => setResourceActive(r.id, !r.active))}>
            {r.active ? "Retire" : "Restore"}
          </button>
        </div>
      </div>

      {editing && (
        <div className="space-y-2">
          <ResourceFields data={data} set={(p) => setData({ ...data, ...p })} branches={branches} users={users} />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => updateResource(r.id, data), () => setEditing(false))}>
            Save
          </button>
        </div>
      )}
      {open === "roster" && <RosterEditor resourceId={r.id} initial={r.roster} branches={branches} defaultBranch={r.branchId} />}
      {open === "timeoff" && <TimeOffEditor resourceId={r.id} rows={r.timeOff} />}
      <Msg msg={msg} />
    </div>
  );
}

function RosterEditor({
  resourceId,
  initial,
  branches,
  defaultBranch,
}: {
  resourceId: string;
  initial: RosterRowInput[];
  branches: Opt[];
  defaultBranch: string | null;
}) {
  const [rows, setRows] = useState<RosterRowInput[]>(initial);
  const { run, pending, msg } = useRun();
  const blank = (): RosterRowInput => ({ branchId: defaultBranch ?? branches[0]?.id ?? "", weekday: 1, start: "10:00", end: "18:00" });
  const set = (i: number, p: Partial<RosterRowInput>) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <div className="space-y-2 rounded-lg border border-cara-rule p-3">
      {rows.length === 0 && <p className="cara-note text-[12px]">No roster — available whenever the branch is open.</p>}
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select className="cara-select w-auto!" value={row.weekday} onChange={(e) => set(i, { weekday: Number(e.target.value) })}>
            {WEEKDAY_LABELS.map((l, d) => (
              <option key={d} value={d}>{l}</option>
            ))}
          </select>
          <input type="time" className="cara-input w-[7.75rem]!" value={row.start} onChange={(e) => set(i, { start: e.target.value })} aria-label="From" />
          <input type="time" className="cara-input w-[7.75rem]!" value={row.end} onChange={(e) => set(i, { end: e.target.value })} aria-label="To" />
          <select className="cara-select w-auto!" value={row.branchId} onChange={(e) => set(i, { branchId: e.target.value })}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <button className="cara-btn" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button className="cara-btn" onClick={() => setRows([...rows, blank()])}>+ Add a day</button>
        <button
          className="cara-btn"
          onClick={() => {
            const b = blank();
            setRows([1, 2, 3, 4, 5, 6].map((weekday) => ({ ...b, weekday })));
          }}
        >
          Mon–Sat template
        </button>
        <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => saveRoster(resourceId, rows))}>
          Save roster
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

function TimeOffEditor({
  resourceId,
  rows,
}: {
  resourceId: string;
  rows: { id: string; start: string; end: string; reason: string | null; source: string }[];
}) {
  const [form, setForm] = useState({ start: "", end: "", reason: "" });
  const { run, pending, msg } = useRun();
  return (
    <div className="space-y-2 rounded-lg border border-cara-rule p-3">
      {rows.length === 0 && <p className="cara-note text-[12px]">Nothing upcoming.</p>}
      {rows.map((t) => (
        <div key={t.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <span>{t.start} → {t.end}</span>
          {t.reason && <span className="text-cara-muted">· {t.reason}</span>}
          {t.source !== "manual" && <span className="tag tag-neutral">{t.source}</span>}
          <button className="cara-btn" disabled={pending} onClick={() => run(() => deleteTimeOff(t.id))}>Remove</button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input type="datetime-local" className="cara-input w-auto!" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} aria-label="From" />
        <span className="text-[12px] text-cara-muted">to</span>
        <input type="datetime-local" className="cara-input w-auto!" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} aria-label="To" />
        <input className="cara-input min-w-[10rem]! flex-1" placeholder="Reason (leave, conference, service…)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        <button
          className="cara-btn cara-btn-primary"
          disabled={pending}
          onClick={() => run(() => addTimeOff(resourceId, form.start, form.end, form.reason), () => setForm({ start: "", end: "", reason: "" }))}
        >
          Add
        </button>
      </div>
      <Msg msg={msg} />
    </div>
  );
}
