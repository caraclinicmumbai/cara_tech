"use client";

// Branch opening hours, holidays (§3.2 1.C) and travel time between branches (§2.2.a)
// — the Scheduling setup "Hours & holidays" tab.
import { useState } from "react";
import {
  saveBranchHours,
  addClosure,
  deleteClosure,
  saveTravelTime,
  setSchedulingNumber,
  type DayHoursInput,
} from "@/app/(dashboard)/appointments/setup/actions";
import { WEEKDAY_LABELS } from "@/lib/scheduling/time";
import { Msg, useRun } from "./useRun";

export function BranchHoursEditor({
  branchId,
  branchName,
  configured,
  week,
}: {
  branchId: string;
  branchName: string;
  configured: boolean;
  week: DayHoursInput[];
}) {
  const [days, setDays] = useState(week);
  const { run, pending, msg } = useRun();
  const set = (i: number, patch: Partial<DayHoursInput>) =>
    setDays((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="cara-card space-y-3 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium text-cara-ink">{branchName}</div>
        {!configured && (
          <span className="cara-note text-[12px]">Not set yet — using the default 09:00–20:00 every day</span>
        )}
      </div>
      <div className="grid max-w-3xl gap-x-10 gap-y-2 md:grid-cols-2">
        {days.map((d, i) => (
          <div key={d.weekday} className="flex items-center gap-2">
            <span className="w-9 text-[12px] font-semibold text-cara-muted">{WEEKDAY_LABELS[d.weekday]}</span>
            {d.closed ? (
              <span className="flex-1 text-[12px] text-cara-faint">Closed</span>
            ) : (
              <>
                <input type="time" className="cara-input w-[7.75rem]!" value={d.open} onChange={(e) => set(i, { open: e.target.value })} aria-label={`${WEEKDAY_LABELS[d.weekday]} opens`} />
                <input type="time" className="cara-input w-[7.75rem]!" value={d.close} onChange={(e) => set(i, { close: e.target.value })} aria-label={`${WEEKDAY_LABELS[d.weekday]} closes`} />
              </>
            )}
            <label className="flex items-center gap-1 text-[12px] text-cara-muted">
              <input type="checkbox" checked={d.closed} onChange={(e) => set(i, { closed: e.target.checked })} />
              closed
            </label>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => saveBranchHours(branchId, days))}>
          Save hours
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

type ClosureView = {
  id: string;
  branchName: string | null;
  startDate: string;
  endDate: string;
  hours: string | null;
  reason: string;
};

export function ClosuresEditor({
  branches,
  closures,
}: {
  branches: { id: string; name: string }[];
  closures: ClosureView[];
}) {
  const empty = { branchId: "", startDate: "", endDate: "", startTime: "", endTime: "", reason: "" };
  const [form, setForm] = useState(empty);
  const { run, pending, msg } = useRun();

  return (
    <div className="space-y-3">
      <div className="cara-card space-y-3 p-5">
        <div className="font-medium text-cara-ink">Add a closure</div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="cara-select w-auto!" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <input type="date" className="cara-input w-auto!" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} aria-label="From" />
          <span className="text-[12px] text-cara-muted">to</span>
          <input type="date" className="cara-input w-auto!" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} aria-label="To (optional)" />
          <input className="cara-input min-w-[12rem]! flex-1" placeholder="Reason * (e.g. Diwali)" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-cara-muted">
          <span>Part of the day only:</span>
          <input type="time" className="cara-input w-[7.75rem]!" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} aria-label="From time" />
          <span>–</span>
          <input type="time" className="cara-input w-[7.75rem]!" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} aria-label="To time" />
          <span className="text-cara-faint">(leave blank to close the whole day)</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            className="cara-btn cara-btn-primary"
            disabled={pending}
            onClick={() => run(() => addClosure({ ...form, branchId: form.branchId || null }), () => setForm(empty))}
          >
            Add closure
          </button>
          <Msg msg={msg} />
        </div>
      </div>

      {closures.length === 0 ? (
        <p className="cara-note">No upcoming closures.</p>
      ) : (
        <div className="cara-card overflow-x-auto">
          <table className="cara-table">
            <thead>
              <tr>
                <th>Dates</th>
                <th>Branch</th>
                <th>Hours</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {closures.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap">{c.startDate === c.endDate ? c.startDate : `${c.startDate} → ${c.endDate}`}</td>
                  <td>{c.branchName ?? "All branches"}</td>
                  <td>{c.hours ?? "Whole day"}</td>
                  <td>{c.reason}</td>
                  <td className="text-right">
                    <button
                      className="cara-btn"
                      disabled={pending}
                      onClick={() => {
                        if (confirm(`Remove the closure "${c.reason}"? Slots on those dates will open for booking.`)) run(() => deleteClosure(c.id));
                      }}
                    >
                      Remove
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

/// Travel time between branches (§2.2.a): the default for any pair, and per-pair times.
export function TravelSetup({
  branches,
  defaultMinutes,
  pairs,
}: {
  branches: { id: string; name: string }[];
  defaultMinutes: number;
  pairs: { a: string; b: string; minutes: number }[];
}) {
  const { run, pending, msg } = useRun();
  const [def, setDef] = useState(String(defaultMinutes));
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const initial = Object.fromEntries(pairs.map((p) => [key(p.a, p.b), String(p.minutes)]));
  const [vals, setVals] = useState<Record<string, string>>(initial);
  const all: { a: { id: string; name: string }; b: { id: string; name: string } }[] = [];
  for (let i = 0; i < branches.length; i++) for (let j = i + 1; j < branches.length; j++) all.push({ a: branches[i], b: branches[j] });

  return (
    <div className="cara-card space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium text-cara-ink">Default travel time</span>
        <input type="number" min={0} max={600} className="cara-input w-24!" value={def} onChange={(e) => setDef(e.target.value)} aria-label="Default travel minutes" />
        <span className="text-cara-muted">min, for any pair below left blank</span>
        <button
          className="cara-btn"
          disabled={pending}
          onClick={() => run(() => setSchedulingNumber("scheduling.defaultTravelMinutes", Number(def)))}
        >
          Save default
        </button>
      </div>
      {all.length === 0 ? (
        <p className="cara-note text-[12px]">Travel times appear once there are two or more branches.</p>
      ) : (
        <table className="cara-table">
          <thead>
            <tr>
              <th>Between</th>
              <th>And</th>
              <th>Minutes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {all.map(({ a, b }) => {
              const k = key(a.id, b.id);
              return (
                <tr key={k}>
                  <td>{a.name}</td>
                  <td>{b.name}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={600}
                      className="cara-input w-24!"
                      placeholder={`${defaultMinutes} (default)`}
                      value={vals[k] ?? ""}
                      onChange={(e) => setVals({ ...vals, [k]: e.target.value })}
                      aria-label={`Minutes between ${a.name} and ${b.name}`}
                    />
                  </td>
                  <td className="text-right">
                    <button
                      className="cara-btn"
                      disabled={pending}
                      onClick={() => run(() => saveTravelTime(a.id, b.id, vals[k]?.trim() ? Number(vals[k]) : null))}
                    >
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Msg msg={msg} />
    </div>
  );
}
