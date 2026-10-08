"use client";

// Appointment types (§3.2 1.4) — the Scheduling setup "Appointment types" tab. What
// each kind of appointment takes: how long, how much turnover after, and which
// resources must all be free (1 doctor + 1 OT room + 2 technicians for an FUE day).
import { useState } from "react";
import {
  createAppointmentType,
  updateAppointmentType,
  setAppointmentTypeActive,
  type AppointmentTypeInput,
  type RequirementInput,
} from "@/app/(dashboard)/appointments/setup/actions";
import { RESOURCE_KINDS, RESOURCE_KIND_LABELS, type ResourceKind } from "@/lib/scheduling/status";
import { Msg, useRun } from "./useRun";

type TypeView = AppointmentTypeInput & { id: string; active: boolean; catalogName: string | null };
type ResourceOpt = { id: string; name: string; kind: string };

const EMPTY: AppointmentTypeInput = {
  name: "",
  code: "",
  category: "",
  durationMin: 30,
  bufferAfterMin: 0,
  catalogItemId: "",
  onlineBookable: false,
  prepInstructions: "",
  color: "",
  requirements: [
    { kind: "doctor", subtype: "", resourceId: "", quantity: 1 },
    { kind: "room", subtype: "consultation", resourceId: "", quantity: 1 },
  ],
};

function describe(r: RequirementInput, resources: ResourceOpt[]): string {
  if (r.resourceId) return resources.find((x) => x.id === r.resourceId)?.name ?? "specific resource";
  const kind = RESOURCE_KIND_LABELS[r.kind as ResourceKind]?.toLowerCase() ?? r.kind;
  return `${r.quantity} × ${r.subtype ? `${r.subtype} ` : ""}${r.kind === "staff" && r.subtype ? "" : kind}`.trim();
}

function TypeForm({
  data,
  set,
  resources,
  subtypes,
  catalog,
}: {
  data: AppointmentTypeInput;
  set: (p: Partial<AppointmentTypeInput>) => void;
  resources: ResourceOpt[];
  subtypes: { kind: string; subtype: string }[];
  catalog: { id: string; label: string }[];
}) {
  const setReq = (i: number, p: Partial<RequirementInput>) =>
    set({ requirements: data.requirements.map((r, j) => (j === i ? { ...r, ...p } : r)) });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className="cara-input min-w-[14rem]! flex-1" placeholder="Name * (e.g. Hair Consultation)" value={data.name} onChange={(e) => set({ name: e.target.value })} />
        <input className="cara-input w-36!" placeholder="Category (Hair, Skin…)" value={data.category ?? ""} onChange={(e) => set({ category: e.target.value })} />
        <input className="cara-input w-24!" placeholder="Code" value={data.code ?? ""} onChange={(e) => set({ code: e.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-cara-muted">
        <label className="flex items-center gap-1">
          Duration
          <input type="number" min={5} step={5} className="cara-input w-20!" value={data.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })} />
          min
        </label>
        <label className="flex items-center gap-1">
          Turnover after
          <input type="number" min={0} step={5} className="cara-input w-20!" value={data.bufferAfterMin} onChange={(e) => set({ bufferAfterMin: Number(e.target.value) })} />
          min
        </label>
        <select className="cara-select w-auto! max-w-[22rem]!" value={data.catalogItemId ?? ""} onChange={(e) => set({ catalogItemId: e.target.value })}>
          <option value="">Not linked to a catalog item</option>
          {catalog.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={data.onlineBookable} onChange={(e) => set({ onlineBookable: e.target.checked })} />
          patients can book online
        </label>
      </div>

      <div className="space-y-2 rounded-lg border border-cara-rule p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-cara-muted">Needs, all free at once</div>
        {data.requirements.length === 0 && <p className="cara-note text-[12px]">No requirements — nothing is reserved.</p>}
        {data.requirements.map((r, i) => {
          const kindSubtypes = subtypes.filter((s) => s.kind === r.kind);
          const kindResources = resources.filter((x) => x.kind === r.kind);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input type="number" min={1} max={20} className="cara-input w-16!" value={r.quantity} disabled={!!r.resourceId} onChange={(e) => setReq(i, { quantity: Number(e.target.value) })} aria-label="Quantity" />
              <select className="cara-select w-auto!" value={r.kind} onChange={(e) => setReq(i, { kind: e.target.value, subtype: "", resourceId: "" })}>
                {RESOURCE_KINDS.map((k) => (
                  <option key={k} value={k}>{RESOURCE_KIND_LABELS[k]}</option>
                ))}
              </select>
              <input
                className="cara-input w-40!"
                list={`subtypes-${r.kind}`}
                placeholder="any type"
                value={r.subtype ?? ""}
                disabled={!!r.resourceId}
                onChange={(e) => setReq(i, { subtype: e.target.value })}
                aria-label="Type"
              />
              <datalist id={`subtypes-${r.kind}`}>
                {kindSubtypes.map((s) => (
                  <option key={s.subtype} value={s.subtype} />
                ))}
              </datalist>
              <select className="cara-select w-auto!" value={r.resourceId ?? ""} onChange={(e) => setReq(i, { resourceId: e.target.value })}>
                <option value="">any matching</option>
                {kindResources.map((x) => (
                  <option key={x.id} value={x.id}>only {x.name}</option>
                ))}
              </select>
              <button className="cara-btn" onClick={() => set({ requirements: data.requirements.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          );
        })}
        <button className="cara-btn" onClick={() => set({ requirements: [...data.requirements, { kind: "staff", subtype: "technician", resourceId: "", quantity: 1 }] })}>
          + Add a requirement
        </button>
      </div>

      <textarea
        className="cara-textarea w-full!"
        rows={2}
        placeholder="Preparation instructions sent to the patient (optional) — e.g. wash hair the night before, no blood thinners for 7 days"
        value={data.prepInstructions ?? ""}
        onChange={(e) => set({ prepInstructions: e.target.value })}
      />
    </div>
  );
}

export function TypesSetup({
  hasBranches,
  resources,
  subtypes,
  catalog,
  types,
}: {
  hasBranches: boolean;
  resources: ResourceOpt[];
  subtypes: { kind: string; subtype: string }[];
  catalog: { id: string; label: string }[];
  types: TypeView[];
}) {
  const [form, setForm] = useState<AppointmentTypeInput>(EMPTY);
  const [adding, setAdding] = useState(types.length === 0);
  const { run, pending, msg } = useRun();

  return (
    <div className="space-y-4">
      {!hasBranches && <div className="cara-notice is-warn">Create a branch first, under Branches.</div>}
      {resources.length === 0 && (
        <div className="cara-notice is-info">Add your doctors, rooms and staff under Resources first, so types can ask for them.</div>
      )}

      {adding ? (
        <div className="cara-card space-y-3 p-5">
          <div className="font-medium text-cara-ink">New appointment type</div>
          <TypeForm data={form} set={(p) => setForm({ ...form, ...p })} resources={resources} subtypes={subtypes} catalog={catalog} />
          <div className="flex items-center gap-3">
            <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => createAppointmentType(form), () => { setForm(EMPTY); setAdding(false); })}>
              Add type
            </button>
            <button className="cara-btn" onClick={() => setAdding(false)}>Cancel</button>
            <Msg msg={msg} />
          </div>
        </div>
      ) : (
        <button className="cara-btn cara-btn-primary" onClick={() => setAdding(true)}>+ New appointment type</button>
      )}

      <div className="space-y-3">
        {types.map((t) => (
          <TypeCard key={t.id} t={t} resources={resources} subtypes={subtypes} catalog={catalog} />
        ))}
      </div>
    </div>
  );
}

function TypeCard({
  t,
  resources,
  subtypes,
  catalog,
}: {
  t: TypeView;
  resources: ResourceOpt[];
  subtypes: { kind: string; subtype: string }[];
  catalog: { id: string; label: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [data, setData] = useState<AppointmentTypeInput>({
    ...t,
    code: t.code ?? "",
    category: t.category ?? "",
    catalogItemId: t.catalogItemId ?? "",
    prepInstructions: t.prepInstructions ?? "",
    requirements: t.requirements.map((r) => ({ ...r, subtype: r.subtype ?? "", resourceId: r.resourceId ?? "" })),
  });
  const { run, pending, msg } = useRun();

  return (
    <div className={`cara-card space-y-3 p-4 ${t.active ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-cara-ink">{t.name}</span>
            {t.category && <span className="tag tag-ink">{t.category}</span>}
            {t.onlineBookable && <span className="tag tag-aqua">online</span>}
            {!t.active && <span className="tag tag-neutral">inactive</span>}
          </div>
          <div className="text-[12px] text-cara-muted">
            {t.durationMin} min{t.bufferAfterMin ? ` + ${t.bufferAfterMin} min turnover` : ""} · needs{" "}
            {t.requirements.length ? t.requirements.map((r) => describe(r, resources)).join(", ") : "nothing"}
            {t.catalogName ? ` · bills as ${t.catalogName}` : ""}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="cara-btn" onClick={() => setEditing(!editing)}>{editing ? "Close" : "Edit"}</button>
          <button className="cara-btn" disabled={pending} onClick={() => run(() => setAppointmentTypeActive(t.id, !t.active))}>
            {t.active ? "Retire" : "Restore"}
          </button>
        </div>
      </div>
      {editing && (
        <div className="space-y-3">
          <TypeForm data={data} set={(p) => setData({ ...data, ...p })} resources={resources} subtypes={subtypes} catalog={catalog} />
          <p className="cara-note text-[12px]">Changes apply to new bookings. Appointments already booked keep their resources.</p>
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => updateAppointmentType(t.id, data), () => setEditing(false))}>
            Save
          </button>
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}
