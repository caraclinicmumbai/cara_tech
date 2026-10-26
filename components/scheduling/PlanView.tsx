"use client";

// One patient's plan (§2.8): steps, windows, statuses, and what staff can do with each.
import { useState } from "react";
import { bookStep, cancelPlan, extendPlanStep, markPlanReviewed, retargetPlanStep, setPlanDoctor, stepSlots, waivePlanStep } from "@/app/(dashboard)/appointments/plans/actions";
import { Msg, useRun } from "./useRun";

type Step = {
  id: string;
  order: number;
  label: string;
  typeName: string;
  status: string;
  dueFrom: string;
  dueTo: string;
  overdue: boolean;
  due: boolean;
  appointment: { startAt: string; status: string; branch: string } | null;
  callRequired: boolean;
  recallStage: number;
  note: string | null;
};

const TZ = "Asia/Kolkata";
const dFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const dtFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
const tFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const day = (k: string) => dFmt.format(new Date(`${k}T12:00:00+05:30`));

function StatusTag({ s }: { s: Step }) {
  if (s.status === "completed") return <span className="tag tag-aqua">completed</span>;
  if (s.status === "waived") return <span className="tag tag-neutral">waived</span>;
  if (s.status === "booked") return <span className="tag tag-blue">booked</span>;
  if (s.overdue) return <span className="tag tag-tangerine">overdue</span>;
  if (s.due) return <span className="tag tag-citric">due now</span>;
  return <span className="tag tag-ink">planned</span>;
}

function StepRow({ s, canAct, today }: { s: Step; canAct: boolean; today: string }) {
  const [mode, setMode] = useState<"none" | "book" | "extend" | "waive" | "redate">("none");
  const [date, setDate] = useState(s.dueFrom > today ? s.dueFrom : today);
  const [slots, setSlots] = useState<{ startAt: string }[] | null>(null);
  const [days, setDays] = useState("14");
  const [reason, setReason] = useState("");
  const { run, pending, msg } = useRun();
  const load = (d: string) => {
    setDate(d);
    setSlots(null);
    stepSlots(s.id, d).then(setSlots);
  };
  return (
    <div className="space-y-2 border-b border-cara-rule px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-[12px] text-cara-muted">{s.order}.</span>
        <span className="font-medium text-cara-ink">{s.label}</span>
        <span className="text-[12px] text-cara-muted">{s.typeName}</span>
        <StatusTag s={s} />
        {s.callRequired && <span className="tag tag-fushia">call required</span>}
        <span className="ml-auto text-[12.5px] text-cara-muted">
          {s.appointment ? `${dtFmt.format(new Date(s.appointment.startAt))} · ${s.appointment.branch}` : `due ${day(s.dueFrom)} – ${day(s.dueTo)}`}
        </span>
      </div>
      {s.note && <div className="pl-7 text-[11.5px] text-cara-faint">{s.note}</div>}
      {canAct && s.status === "planned" && mode === "none" && (
        <div className="flex flex-wrap gap-2 pl-7">
          <button className="cara-btn cara-btn-primary" onClick={() => { setMode("book"); load(date); }}>Book</button>
          <button className="cara-btn" onClick={() => setMode("extend")}>Extend window</button>
          <button className="cara-btn" onClick={() => setMode("redate")}>Change date</button>
          <button className="cara-btn" onClick={() => setMode("waive")}>Waive</button>
        </div>
      )}
      {mode === "book" && (
        <div className="space-y-2 pl-7">
          <input type="date" className="cara-input w-auto!" value={date} min={today} onChange={(e) => e.target.value && load(e.target.value)} aria-label="Date" />
          {slots === null ? (
            <p className="text-[12px] text-cara-muted">Loading…</p>
          ) : slots.length === 0 ? (
            <p className="text-[12px] text-cara-muted">No free time that day.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {slots.map((x) => (
                <button key={x.startAt} className="tag tag-aqua" disabled={pending} onClick={() => run(() => bookStep(s.id, x.startAt), () => setMode("none"))}>
                  {tFmt.format(new Date(x.startAt))}
                </button>
              ))}
            </div>
          )}
          <button className="cara-btn" onClick={() => setMode("none")}>Back</button>
        </div>
      )}
      {mode === "extend" && (
        <div className="flex flex-wrap items-center gap-2 pl-7 text-[12.5px]">
          by <input type="number" min={1} className="cara-input w-16!" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days" /> days
          <input className="cara-input min-w-[12rem]! flex-1" placeholder="Reason *" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => extendPlanStep(s.id, Number(days), reason), () => setMode("none"))}>Extend</button>
          <button className="cara-btn" onClick={() => setMode("none")}>Back</button>
        </div>
      )}
      {mode === "waive" && (
        <div className="flex flex-wrap items-center gap-2 pl-7 text-[12.5px]">
          <input className="cara-input min-w-[12rem]! flex-1" placeholder="Reason *" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="cara-btn cara-btn-danger" disabled={pending} onClick={() => run(() => waivePlanStep(s.id, reason), () => setMode("none"))}>Waive step</button>
          <button className="cara-btn" onClick={() => setMode("none")}>Back</button>
        </div>
      )}
      {mode === "redate" && (
        <div className="flex flex-wrap items-center gap-2 pl-7 text-[12.5px]">
          new target <input type="date" className="cara-input w-auto!" value={date} onChange={(e) => setDate(e.target.value)} aria-label="New target" />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => retargetPlanStep(s.id, date), () => setMode("none"))}>Save</button>
          <button className="cara-btn" onClick={() => setMode("none")}>Back</button>
        </div>
      )}
      <div className="pl-7"><Msg msg={msg} /></div>
    </div>
  );
}

export function PlanView({
  planId,
  active,
  needsReview,
  reviewNote,
  canAct,
  today,
  steps,
  doctorId,
  doctors,
}: {
  doctorId: string | null;
  doctors: { id: string; name: string }[];
  planId: string;
  active: boolean;
  needsReview: boolean;
  reviewNote: string | null;
  canAct: boolean;
  today: string;
  steps: Step[];
}) {
  const { run, pending, msg } = useRun();
  const [cancelReason, setCancelReason] = useState("");
  const [doc, setDoc] = useState(doctors[0]?.id ?? "");
  return (
    <div className="space-y-4">
      {!doctorId && canAct && active && (
        <div className="cara-notice is-warn flex flex-wrap items-center gap-2">
          <span>No surgeon on this plan — follow-ups are with the surgeon, so they can&rsquo;t be booked yet.</span>
          <select className="cara-select w-auto!" value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Surgeon">
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="cara-btn cara-btn-primary" disabled={pending || !doc} onClick={() => run(() => setPlanDoctor(planId, doc))}>Set surgeon</button>
        </div>
      )}
      {needsReview && (
        <div className="cara-notice is-warn flex flex-wrap items-center justify-between gap-2">
          <span>{reviewNote ?? "The plan changed — please review the follow-ups."}</span>
          {canAct && <button className="cara-btn" disabled={pending} onClick={() => run(() => markPlanReviewed(planId))}>Reviewed</button>}
        </div>
      )}
      <div className="cara-card">
        {steps.map((s) => <StepRow key={s.id} s={s} canAct={canAct && active} today={today} />)}
      </div>
      {canAct && active && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <input className="cara-input w-72!" placeholder="Reason to cancel the plan" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          <button className="cara-btn" disabled={pending || !cancelReason.trim()} onClick={() => run(() => cancelPlan(planId, cancelReason))}>Cancel plan</button>
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}
