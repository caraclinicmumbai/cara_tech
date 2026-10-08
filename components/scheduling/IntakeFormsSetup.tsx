"use client";

// Intake forms (§2.7) — the Scheduling setup tab. The clinic edits its own questions
// (2.7.a — question lists come from the clinical lead): sections of fields, conditional
// questions ("Diabetic? → Yes → HbA1c"), red-flag answers, separate consent ticks,
// guided photos. Saving publishes a NEW version; old answers keep the version they saw.
import { useState } from "react";
import { createIntakeForm, publishIntakeVersion, setIntakeFormActive } from "@/app/(dashboard)/appointments/setup/actions";
import {
  checkSchema,
  CONSENT_PURPOSES,
  FIELD_TYPE_LABELS,
  FIELD_TYPES,
  PHOTO_SLOT_LABELS,
  type FieldType,
  type IntakeField,
  type IntakeSchema,
} from "@/lib/scheduling/intake/schema";
import { Msg, useRun } from "./useRun";

export type FormView = { id: string; name: string; active: boolean; version: number; schema: IntakeSchema; usedBy: string[]; responses: number };

const keyFrom = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40) || `field_${Date.now().toString(36)}`;

function optionsText(f: IntakeField): string {
  return (f.options ?? []).map((o) => `${o.redFlag ? "!" : ""}${o.label}`).join("\n");
}
function parseOptions(text: string): IntakeField["options"] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const redFlag = l.startsWith("!");
      const label = l.replace(/^!\s*/, "");
      return { value: keyFrom(label), label, ...(redFlag ? { redFlag: true } : {}) };
    });
}

function FieldEditor({
  f,
  earlier,
  set,
  remove,
  move,
}: {
  f: IntakeField;
  earlier: IntakeField[];
  set: (p: Partial<IntakeField>) => void;
  remove: () => void;
  move: (d: -1 | 1) => void;
}) {
  const [opts, setOpts] = useState(optionsText(f));
  const dep = f.showIf ? ("under18" in f.showIf ? "__under18" : f.showIf.field) : "";
  return (
    <div className="space-y-2 rounded-lg border border-cara-rule p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="cara-select w-auto!" value={f.type} onChange={(e) => set({ type: e.target.value as FieldType })} aria-label="Type">
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <input className="cara-input min-w-[14rem]! flex-1" placeholder="Question / label" value={f.label} onChange={(e) => set({ label: e.target.value })} />
        {f.type !== "info" && (
          <label className="flex items-center gap-1 text-[12px] text-cara-muted">
            <input type="checkbox" checked={!!f.required} onChange={(e) => set({ required: e.target.checked })} /> required
          </label>
        )}
        <button className="cara-btn" onClick={() => move(-1)} aria-label="Move up">↑</button>
        <button className="cara-btn" onClick={() => move(1)} aria-label="Move down">↓</button>
        <button className="cara-btn" onClick={remove}>Remove</button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-cara-muted">
        <span>key</span>
        <input className="cara-input w-40!" value={f.key} onChange={(e) => set({ key: e.target.value })} aria-label="Key" />
        <input className="cara-input min-w-[12rem]! flex-1" placeholder="Help text (optional)" value={f.help ?? ""} onChange={(e) => set({ help: e.target.value || undefined })} />
      </div>
      {(f.type === "select" || f.type === "multiselect") && (
        <label className="block space-y-1 text-[12px] text-cara-muted">
          Options, one per line — start a line with <b>!</b> to make that answer a red flag
          <textarea className="cara-textarea" rows={3} value={opts} onChange={(e) => { setOpts(e.target.value); set({ options: parseOptions(e.target.value) }); }} />
        </label>
      )}
      {f.type === "yesno" && (
        <label className="flex items-center gap-1 text-[12px] text-cara-muted">
          <input type="checkbox" checked={!!f.redFlagWhenYes} onChange={(e) => set({ redFlagWhenYes: e.target.checked || undefined })} /> a &ldquo;Yes&rdquo; is a red flag (alerts the doctor)
        </label>
      )}
      {f.type === "consent" && (
        <select className="cara-select w-auto!" value={f.consentPurpose ?? ""} onChange={(e) => set({ consentPurpose: e.target.value || undefined })} aria-label="Consent purpose">
          <option value="">What is this consent for?</option>
          {CONSENT_PURPOSES.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
      )}
      {f.type === "photos" && (
        <div className="flex flex-wrap gap-2 text-[12px] text-cara-muted">
          {Object.entries(PHOTO_SLOT_LABELS).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={(f.photoSlots ?? []).includes(k)}
                onChange={(e) => set({ photoSlots: e.target.checked ? [...(f.photoSlots ?? []), k] : (f.photoSlots ?? []).filter((x) => x !== k) })}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-cara-muted">
        Show
        <select
          className="cara-select w-auto!"
          value={dep}
          onChange={(e) => {
            const v = e.target.value;
            set({ showIf: v === "" ? undefined : v === "__under18" ? { under18: true } : { field: v, equals: "yes" } });
          }}
          aria-label="Show when"
        >
          <option value="">always</option>
          <option value="__under18">only if the patient is under 18 (needs a &ldquo;dob&rdquo; date field)</option>
          {earlier.map((e) => (
            <option key={e.key} value={e.key}>only if &ldquo;{e.label.slice(0, 40)}&rdquo; is…</option>
          ))}
        </select>
        {f.showIf && "field" in f.showIf && (
          <input className="cara-input w-32!" value={f.showIf.equals ?? ""} onChange={(e) => set({ showIf: { field: (f.showIf as { field: string }).field, equals: e.target.value } })} aria-label="Equals" placeholder="yes" />
        )}
      </div>
    </div>
  );
}

function FormEditor({ form, onClose }: { form: FormView; onClose: () => void }) {
  const [schema, setSchema] = useState<IntakeSchema>(structuredClone(form.schema));
  const { run, pending, msg } = useRun();
  const problems = checkSchema(schema);
  const setSection = (si: number, p: Partial<IntakeSchema["sections"][number]>) =>
    setSchema((s) => ({ sections: s.sections.map((x, i) => (i === si ? { ...x, ...p } : x)) }));
  const setField = (si: number, fi: number, p: Partial<IntakeField>) =>
    setSchema((s) => ({ sections: s.sections.map((x, i) => (i === si ? { ...x, fields: x.fields.map((f, j) => (j === fi ? { ...f, ...p } : f)) } : x)) }));

  return (
    <div className="space-y-4">
      {schema.sections.map((sec, si) => {
        const before = schema.sections.slice(0, si).flatMap((x) => x.fields);
        return (
          <div key={sec.id} className="space-y-2 rounded-xl bg-[var(--cara-surface-2)] p-3">
            <div className="flex items-center gap-2">
              <input className="cara-input font-medium" value={sec.title} onChange={(e) => setSection(si, { title: e.target.value })} aria-label="Section title" />
              <button className="cara-btn" onClick={() => setSchema((s) => ({ sections: s.sections.filter((_, i) => i !== si) }))}>Remove section</button>
            </div>
            {sec.fields.map((f, fi) => (
              <FieldEditor
                key={fi}
                f={f}
                earlier={[...before, ...sec.fields.slice(0, fi)].filter((x) => x.type === "yesno" || x.type === "select" || x.type === "multiselect")}
                set={(p) => setField(si, fi, p)}
                remove={() => setSection(si, { fields: sec.fields.filter((_, j) => j !== fi) })}
                move={(d) => {
                  const j = fi + d;
                  if (j < 0 || j >= sec.fields.length) return;
                  const next = [...sec.fields];
                  [next[fi], next[j]] = [next[j], next[fi]];
                  setSection(si, { fields: next });
                }}
              />
            ))}
            <button
              className="cara-btn"
              onClick={() => setSection(si, { fields: [...sec.fields, { key: `question_${sec.fields.length + 1}_${Date.now().toString(36).slice(-3)}`, label: "", type: "text" }] })}
            >
              + Add question
            </button>
          </div>
        );
      })}
      <button className="cara-btn" onClick={() => setSchema((s) => ({ sections: [...s.sections, { id: `s${Date.now().toString(36)}`, title: "New section", fields: [] }] }))}>
        + Add section
      </button>
      {problems.length > 0 && (
        <div className="cara-notice is-warn text-[12.5px]">
          <ul className="list-disc pl-5">{problems.slice(0, 6).map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button className="cara-btn cara-btn-primary" disabled={pending || problems.length > 0} onClick={() => run(() => publishIntakeVersion(form.id, schema), onClose)}>
          Publish version {form.version + 1}
        </button>
        <button className="cara-btn" onClick={onClose}>Cancel</button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

export function IntakeFormsSetup({ forms }: { forms: FormView[] }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const { run, pending, msg } = useRun();
  return (
    <div className="space-y-4">
      <div className="cara-card space-y-3 p-5">
        <div className="font-medium text-cara-ink">New intake form</div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="cara-input min-w-[14rem]! flex-1" placeholder="Name (e.g. Hair loss consultation)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => createIntakeForm(name || "Hair loss consultation", true), () => setName(""))}>
            Start from the hair-loss template
          </button>
          <button className="cara-btn" disabled={pending} onClick={() => run(() => createIntakeForm(name, false), () => setName(""))}>Blank form</button>
        </div>
        <p className="cara-note text-[12px]">
          The template is the spec&rsquo;s example — a starting point for the clinical lead, not a clinical standard. Then pick the form for each
          appointment type under Appointment types.
        </p>
        <Msg msg={msg} />
      </div>

      {forms.map((f) => (
        <div key={f.id} className={`cara-card space-y-3 p-4 ${f.active ? "" : "opacity-60"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-cara-ink">{f.name}</span>
              <span className="tag tag-ink">v{f.version}</span>
              <span className="text-[12px] text-cara-muted">
                {f.schema.sections.reduce((n, s) => n + s.fields.length, 0)} questions · {f.responses} completed
                {f.usedBy.length ? ` · used by ${f.usedBy.join(", ")}` : " · not assigned to a type yet"}
              </span>
            </div>
            <div className="flex gap-2">
              <button className="cara-btn" onClick={() => setEditing(editing === f.id ? null : f.id)}>{editing === f.id ? "Close" : "Edit"}</button>
              <button className="cara-btn" disabled={pending} onClick={() => run(() => setIntakeFormActive(f.id, !f.active))}>{f.active ? "Retire" : "Restore"}</button>
            </div>
          </div>
          {editing === f.id && <FormEditor form={f} onClose={() => setEditing(null)} />}
        </div>
      ))}
    </div>
  );
}
