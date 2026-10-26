"use client";

// Treatment series (§2.8) — the Scheduling setup tab. Each series is a list of steps
// measured from the anchor (Day 0): appointment type, offset (days or months),
// tolerance, and whether it's with the plan's surgeon (2.8.f). One month between
// treatments by default (2.8.a); edit freely.
import { useState } from "react";
import { saveSeriesTemplate, setSeriesTemplateActive, type SeriesStepInput, type SeriesTemplateInput } from "@/app/(dashboard)/appointments/setup/actions";
import { Msg, useRun } from "./useRun";

export type SeriesView = SeriesTemplateInput & { id: string; active: boolean; plans: number };
type Opt = { id: string; name: string };

function describe(s: SeriesStepInput): string {
  if (s.offsetValue === 0) return "Day 0 (anchor)";
  const unit = s.offsetUnit === "days" ? (s.offsetValue === 1 ? "day" : "days") : s.offsetValue === 1 ? "month" : "months";
  return `${s.offsetUnit === "days" ? "Day" : "Month"} ${s.offsetValue} — ${s.offsetValue} ${unit} after${s.toleranceDays ? `, ±${s.toleranceDays} days` : ""}`;
}

function Editor({ initial, types, onDone }: { initial: SeriesView | null; types: Opt[]; onDone: () => void }) {
  const [f, setF] = useState<SeriesTemplateInput>(
    initial ?? {
      name: "",
      anchorTypeId: "",
      packageName: "",
      autoStart: false,
      steps: [{ label: "Treatment 1", typeId: types[0]?.id ?? "", offsetValue: 0, offsetUnit: "months", toleranceDays: 0, sameDoctor: true }],
    },
  );
  const { run, pending, msg } = useRun();
  const setStep = (i: number, p: Partial<SeriesStepInput>) => setF({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const addMonthLater = () => {
    const last = f.steps[f.steps.length - 1];
    const nextMonths = last ? (last.offsetUnit === "months" ? last.offsetValue + 1 : Math.max(1, Math.round(last.offsetValue / 30) + 1)) : 1;
    setF({ ...f, steps: [...f.steps, { label: `Treatment ${f.steps.length + 1}`, typeId: last?.typeId ?? types[0]?.id ?? "", offsetValue: nextMonths, offsetUnit: "months", toleranceDays: 7, sameDoctor: true }] });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className="cara-input min-w-[14rem]! flex-1" placeholder="Series name (e.g. FUE Hair Transplant Package)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className="cara-input w-64!" placeholder="Package / quote treatment name" value={f.packageName ?? ""} onChange={(e) => setF({ ...f, packageName: e.target.value })} title="Match a converted quote's treatment, for automatic start" />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-cara-muted">
        Anchor (Day 0) appointment type
        <select className="cara-select w-auto!" value={f.anchorTypeId ?? ""} onChange={(e) => setF({ ...f, anchorTypeId: e.target.value })} aria-label="Anchor type">
          <option value="">— none —</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={f.autoStart} onChange={(e) => setF({ ...f, autoStart: e.target.checked })} />
          start the plan automatically when this is booked for a patient who bought the package
        </label>
      </div>
      <div className="space-y-2">
        {f.steps.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--cara-surface-2)] p-2 text-[12.5px]">
            <span className="w-5 text-cara-muted">{i + 1}.</span>
            <input className="cara-input w-56!" value={s.label} onChange={(e) => setStep(i, { label: e.target.value })} aria-label="Step name" />
            <select className="cara-select w-auto! max-w-[14rem]!" value={s.typeId} onChange={(e) => setStep(i, { typeId: e.target.value })} aria-label="Appointment type">
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input type="number" min={0} className="cara-input w-16!" value={s.offsetValue} onChange={(e) => setStep(i, { offsetValue: Number(e.target.value) })} aria-label="Offset" />
            <select className="cara-select w-auto!" value={s.offsetUnit} onChange={(e) => setStep(i, { offsetUnit: e.target.value })} aria-label="Unit">
              <option value="days">days after</option>
              <option value="months">months after</option>
            </select>
            ±
            <input type="number" min={0} className="cara-input w-16!" value={s.toleranceDays} onChange={(e) => setStep(i, { toleranceDays: Number(e.target.value) })} aria-label="Tolerance days" />
            days
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={s.sameDoctor} onChange={(e) => setStep(i, { sameDoctor: e.target.checked })} /> with the surgeon
            </label>
            <span className="text-[11.5px] text-cara-faint">{describe(s)}</span>
            <button className="cara-btn ml-auto" onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button className="cara-btn" onClick={addMonthLater}>+ Step one month later</button>
      </div>
      <div className="flex items-center gap-3">
        <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => saveSeriesTemplate(initial?.id ?? null, f), onDone)}>Save series</button>
        <button className="cara-btn" onClick={onDone}>Cancel</button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

export function SeriesSetup({ series, types }: { series: SeriesView[]; types: Opt[] }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { run, pending } = useRun();
  return (
    <div className="space-y-4">
      <p className="cara-note text-[12.5px]">
        Steps are measured from the anchor — usually the surgery date. Sessions due within 30 days are booked straight away; later ones wait in
        their window and patients get a recall message when it opens. Intervals come from the clinical lead; one month between treatments to start.
      </p>
      {editing === "new" ? (
        <div className="cara-card p-4">
          <Editor initial={null} types={types} onDone={() => setEditing(null)} />
        </div>
      ) : (
        <button className="cara-btn cara-btn-primary" onClick={() => setEditing("new")} disabled={!types.length}>+ New treatment series</button>
      )}
      {series.map((s) => (
        <div key={s.id} className={`cara-card space-y-2 p-4 ${s.active ? "" : "opacity-60"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-cara-ink">{s.name}</span>
              <span className="text-[12px] text-cara-muted">{s.steps.length} steps · {s.plans} plan{s.plans === 1 ? "" : "s"}</span>
              {s.autoStart && <span className="tag tag-aqua">starts automatically</span>}
            </div>
            <div className="flex gap-2">
              <button className="cara-btn" onClick={() => setEditing(editing === s.id ? null : s.id)}>{editing === s.id ? "Close" : "Edit"}</button>
              <button className="cara-btn" disabled={pending} onClick={() => run(() => setSeriesTemplateActive(s.id, !s.active))}>{s.active ? "Retire" : "Restore"}</button>
            </div>
          </div>
          {editing === s.id ? (
            <Editor initial={s} types={types} onDone={() => setEditing(null)} />
          ) : (
            <ol className="list-decimal space-y-0.5 pl-5 text-[12.5px] text-cara-muted">
              {s.steps.map((st, i) => <li key={i}><span className="text-cara-ink">{st.label}</span> — {describe(st)}</li>)}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}
