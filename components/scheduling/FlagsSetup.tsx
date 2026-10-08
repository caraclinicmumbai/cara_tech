"use client";

// Patient flags (§3.2 "Cards and Flags for a Patient") — the Scheduling setup "Patient
// flags" tab. The kinds of flag staff can pin to a patient; each shows on their
// appointment card as a drawn icon in its tag colour.
import { useState } from "react";
import { createFlag, updateFlag, setFlagActive, type FlagInput } from "@/app/(dashboard)/appointments/setup/actions";
import { FLAG_ICONS, FLAG_ICON_LABELS, FLAG_TONES } from "@/lib/scheduling/flags";
import { FlagGlyph } from "@/components/Icon";
import { Msg, useRun } from "./useRun";

type FlagView = FlagInput & { id: string; active: boolean; patients: number };

function FlagFields({ data, set }: { data: FlagInput; set: (p: Partial<FlagInput>) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className="cara-input w-48!" placeholder="Label * (e.g. Medical alert)" value={data.label} onChange={(e) => set({ label: e.target.value })} />
      <select className="cara-select w-auto!" value={data.icon} onChange={(e) => set({ icon: e.target.value })} aria-label="Icon">
        {FLAG_ICONS.map((i) => (
          <option key={i} value={i}>{FLAG_ICON_LABELS[i]}</option>
        ))}
      </select>
      <select className="cara-select w-auto!" value={data.tone} onChange={(e) => set({ tone: e.target.value })} aria-label="Colour">
        {FLAG_TONES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <span className={`tag tag-${data.tone}`}>
        <FlagGlyph icon={data.icon} className="tag-icon" />
        {data.label || "preview"}
      </span>
      <input className="cara-input min-w-[14rem]! flex-1" placeholder="What it means for the desk (optional)" value={data.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
    </div>
  );
}

export function FlagsSetup({ flags }: { flags: FlagView[] }) {
  const empty: FlagInput = { label: "", description: "", icon: "alert", tone: "tangerine" };
  const [form, setForm] = useState<FlagInput>(empty);
  const { run, pending, msg } = useRun();

  return (
    <div className="space-y-4">
      <div className="cara-card space-y-3 p-5">
        <div className="font-medium text-cara-ink">Add a flag</div>
        <FlagFields data={form} set={(p) => setForm({ ...form, ...p })} />
        <div className="flex items-center gap-3">
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => createFlag(form), () => setForm(empty))}>
            Add flag
          </button>
          <Msg msg={msg} />
        </div>
      </div>
      <div className="space-y-3">
        {flags.map((f) => (
          <FlagRow key={f.id} f={f} />
        ))}
      </div>
    </div>
  );
}

function FlagRow({ f }: { f: FlagView }) {
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<FlagInput>({ label: f.label, description: f.description ?? "", icon: f.icon, tone: f.tone });
  const { run, pending, msg } = useRun();
  return (
    <div className={`cara-card space-y-2 p-4 ${f.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`tag tag-${f.tone}`}>
            <FlagGlyph icon={f.icon} className="tag-icon" />
            {f.label}
          </span>
          {f.description && <span className="text-[12px] text-cara-muted">{f.description}</span>}
          <span className="text-[12px] text-cara-faint">· on {f.patients} patient{f.patients === 1 ? "" : "s"}</span>
        </div>
        <div className="flex gap-2">
          <button className="cara-btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>
          <button className="cara-btn" disabled={pending} onClick={() => run(() => setFlagActive(f.id, !f.active))}>
            {f.active ? "Retire" : "Restore"}
          </button>
        </div>
      </div>
      {editing && (
        <div className="space-y-2">
          <FlagFields data={data} set={(p) => setData({ ...data, ...p })} />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => updateFlag(f.id, data), () => setEditing(false))}>
            Save
          </button>
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}
