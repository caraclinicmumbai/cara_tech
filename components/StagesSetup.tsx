"use client";

// Appointment stages (#7) on the Settings page: for each consultation or treatment type,
// the steps of the visit in order, the role that does each one, and its colour.
import { useState } from "react";
import { createStage, moveStage, removeStage, restoreStage, updateStage, type StageInput } from "@/app/(dashboard)/settings/actions";
import { STAGE_ROLES, STAGE_TONES, stageRoleLabel } from "@/lib/scheduling/stages";
import { Msg, useRun } from "@/components/scheduling/useRun";

type StageView = StageInput & { id: string; active: boolean };
type TypeView = { id: string; name: string; category: string | null; stages: StageView[] };

const EMPTY: StageInput = { label: "", role: "doctor", tone: "blue" };

function StageFields({ data, set }: { data: StageInput; set: (p: Partial<StageInput>) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className="cara-input w-56!" placeholder="Stage * (e.g. Scalp analysis)" value={data.label} onChange={(e) => set({ label: e.target.value })} />
      <select className="cara-select w-auto!" value={data.role} onChange={(e) => set({ role: e.target.value })} aria-label="Done by">
        {STAGE_ROLES.map((r) => (
          <option key={r} value={r}>{stageRoleLabel(r)}</option>
        ))}
      </select>
      <select className="cara-select w-auto!" value={data.tone} onChange={(e) => set({ tone: e.target.value })} aria-label="Colour">
        {STAGE_TONES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <span className={`tag tag-${data.tone}`}>{data.label || "preview"}</span>
    </div>
  );
}

export function StagesSetup({ types }: { types: TypeView[] }) {
  if (types.length === 0) {
    return <p className="cara-note">No appointment types yet. Add consultations and treatments under Appointments → Scheduling setup → Appointment types.</p>;
  }
  return (
    <div className="space-y-3">
      {types.map((t) => (
        <TypeStages key={t.id} t={t} />
      ))}
    </div>
  );
}

function TypeStages({ t }: { t: TypeView }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<StageInput>(EMPTY);
  const { run, pending, msg } = useRun();
  const live = t.stages.filter((s) => s.active);
  return (
    <div className="cara-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-cara-ink">{t.name}</span>
          {t.category && <span className="text-[12px] text-cara-faint">{t.category}</span>}
          {live.length === 0 ? (
            <span className="text-[12px] text-cara-faint">· no stages yet</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {live.map((s) => (
                <span key={s.id} className={`tag tag-${s.tone}`}>{s.label}</span>
              ))}
            </span>
          )}
        </div>
        <button className="cara-btn" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit stages"}</button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-cara-rule pt-3">
          {t.stages.map((s, i) => (
            <StageRow key={s.id} s={s} first={i === 0} last={i === t.stages.length - 1} />
          ))}
          <div className="space-y-2 pt-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-cara-muted">Add a stage</div>
            <StageFields data={form} set={(p) => setForm({ ...form, ...p })} />
            <div className="flex items-center gap-3">
              <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => createStage(t.id, form), () => setForm({ ...EMPTY, role: form.role }))}>
                Add stage
              </button>
              <Msg msg={msg} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StageRow({ s, first, last }: { s: StageView; first: boolean; last: boolean }) {
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<StageInput>({ label: s.label, role: s.role, tone: s.tone });
  const { run, pending, msg } = useRun();
  return (
    <div className={`space-y-2 ${s.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`tag tag-${s.tone}`}>{s.label}</span>
          <span className="text-[12px] text-cara-muted">{stageRoleLabel(s.role)}</span>
          {!s.active && <span className="text-[12px] text-cara-faint">· retired</span>}
        </div>
        <div className="flex gap-1.5">
          <button className="cara-btn" disabled={pending || first} onClick={() => run(() => moveStage(s.id, -1))} aria-label={`Move ${s.label} up`}>↑</button>
          <button className="cara-btn" disabled={pending || last} onClick={() => run(() => moveStage(s.id, 1))} aria-label={`Move ${s.label} down`}>↓</button>
          <button className="cara-btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>
          {s.active ? (
            <button className="cara-btn" disabled={pending} onClick={() => run(() => removeStage(s.id))}>Remove</button>
          ) : (
            <button className="cara-btn" disabled={pending} onClick={() => run(() => restoreStage(s.id))}>Restore</button>
          )}
        </div>
      </div>
      {editing && (
        <div className="flex flex-wrap items-center gap-2">
          <StageFields data={data} set={(p) => setData({ ...data, ...p })} />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => updateStage(s.id, data), () => setEditing(false))}>
            Save
          </button>
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}
