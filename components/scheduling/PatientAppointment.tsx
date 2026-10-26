"use client";

// What the patient sees from their reminder link (§2.4): the appointment, directions,
// preparation, and — within the self-service cut-off — confirm / pick a new time /
// cancel. Inside the cut-off it says "please call" and offers "ask us to call you".
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  patientCancel,
  patientConfirm,
  patientRequestChange,
  patientReschedule,
  patientSlots,
} from "@/app/(public)/a/[token]/actions";

const TZ = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

export function PatientAppointment(p: {
  token: string;
  moved: boolean;
  firstName: string;
  service: string;
  startAt: string;
  endAt: string;
  status: string;
  branch: string;
  address: string;
  mapLink: string;
  phone: string | null;
  doctor: string | null;
  prep: string | null;
  canConfirm: boolean;
  canChange: boolean;
  callRequired: boolean;
  cutoffHours: number;
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mode, setMode] = useState<"none" | "move" | "cancel" | "request">("none");
  const [day, setDay] = useState(addDays(p.today, 1));
  const [slots, setSlots] = useState<{ startAt: string; endAt: string }[] | null>(null);
  const [reason, setReason] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string; info?: string; token?: string }>) =>
    startTransition(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.info ?? "Done") : (r.error ?? "Something went wrong") });
      if (r.ok) {
        setMode("none");
        if (r.token) router.replace(`/a/${r.token}`);
        else router.refresh();
      }
    });

  const loadSlots = (d: string) => {
    setDay(d);
    setSlots(null);
    startTransition(async () => setSlots(await patientSlots(p.token, d)));
  };

  const ended = ["cancelled", "completed", "no_show"].includes(p.status);
  const callLine = p.phone ? <a href={`tel:${p.phone}`} className="font-medium underline">{p.phone}</a> : "the clinic";

  return (
    <div className="space-y-4">
      {p.moved && <div className="cara-notice is-info">Your appointment was moved. Here are the new details.</div>}
      <div className="cara-card space-y-2 p-5">
        <div className="text-[13px] text-cara-muted">Hi {p.firstName},</div>
        <div className="text-[17px] font-semibold text-cara-ink">{p.service}</div>
        <div className="text-[15px]">
          {dayFmt.format(new Date(p.startAt))}
          <br />
          {timeFmt.format(new Date(p.startAt)).toUpperCase()} – {timeFmt.format(new Date(p.endAt)).toUpperCase()}
        </div>
        <div className="text-[14px]">
          {p.branch}
          {p.doctor ? ` · with ${p.doctor}` : ""}
        </div>
        {p.address && <div className="text-[13px] text-cara-muted">{p.address}</div>}
        <a href={p.mapLink} target="_blank" rel="noreferrer" className="inline-block text-[13px] underline">Directions</a>
        <div className="pt-1">
          <span className={`tag ${p.status === "confirmed" ? "tag-aqua" : ended ? "tag-neutral" : "tag-blue"}`}>
            {p.status === "confirmed" ? "confirmed" : p.status === "booked" ? "booked" : p.status.replace("_", " ")}
          </span>
        </div>
      </div>

      {p.prep && !ended && (
        <div className="cara-card space-y-1 p-5">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-cara-muted">Before you come</div>
          <div className="whitespace-pre-line text-[14px]">{p.prep}</div>
        </div>
      )}

      {msg && <div className={`cara-notice ${msg.ok ? "is-good" : "is-bad"}`}>{msg.text}</div>}

      {!ended && mode === "none" && (
        <div className="space-y-2">
          {p.canConfirm && (
            <button className="cara-btn cara-btn-primary w-full" disabled={pending} onClick={() => run(() => patientConfirm(p.token))}>
              Confirm I&rsquo;ll be there
            </button>
          )}
          {p.canChange && (
            <>
              <button className="cara-btn w-full" disabled={pending} onClick={() => { setMode("move"); loadSlots(day); }}>Choose a different time</button>
              <button className="cara-btn w-full" disabled={pending} onClick={() => setMode("cancel")}>Cancel this appointment</button>
            </>
          )}
          {p.callRequired && (
            <div className="cara-card space-y-2 p-4 text-[14px]">
              <p>
                It&rsquo;s less than {p.cutoffHours} hours to your appointment, so changes are made by phone. Please call {callLine}.
              </p>
              <button className="cara-btn w-full" disabled={pending} onClick={() => setMode("request")}>Ask the clinic to call me</button>
            </div>
          )}
        </div>
      )}

      {mode === "move" && (
        <div className="cara-card space-y-3 p-5">
          <div className="font-medium">Pick a new time</div>
          <div className="flex items-center gap-2">
            <button className="cara-btn" disabled={pending || day <= addDays(p.today, 0)} onClick={() => loadSlots(addDays(day, -1))} aria-label="Previous day">‹</button>
            <div className="flex-1 text-center text-[14px]">{dayFmt.format(new Date(`${day}T12:00:00+05:30`))}</div>
            <button className="cara-btn" disabled={pending || day >= addDays(p.today, 30)} onClick={() => loadSlots(addDays(day, 1))} aria-label="Next day">›</button>
          </div>
          {slots === null ? (
            <p className="text-[13px] text-cara-muted">Looking for free times…</p>
          ) : slots.length === 0 ? (
            <p className="text-[13px] text-cara-muted">No free times this day — try the next.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {slots.map((s) => (
                <button
                  key={s.startAt}
                  className="cara-btn"
                  disabled={pending}
                  onClick={() => confirm(`Move to ${dayFmt.format(new Date(s.startAt))}, ${timeFmt.format(new Date(s.startAt))}?`) && run(() => patientReschedule(p.token, s.startAt))}
                >
                  {timeFmt.format(new Date(s.startAt))}
                </button>
              ))}
            </div>
          )}
          <button className="cara-btn w-full" onClick={() => setMode("none")}>Back</button>
        </div>
      )}

      {mode === "cancel" && (
        <div className="cara-card space-y-3 p-5">
          <div className="font-medium">Cancel your appointment?</div>
          <input className="cara-input" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="cara-btn cara-btn-danger w-full" disabled={pending} onClick={() => run(() => patientCancel(p.token, reason))}>Yes, cancel it</button>
          <button className="cara-btn w-full" onClick={() => setMode("none")}>Keep my appointment</button>
        </div>
      )}

      {mode === "request" && (
        <div className="cara-card space-y-3 p-5">
          <div className="font-medium">What would you like to change?</div>
          <input className="cara-input" placeholder="e.g. need a later time" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="cara-btn cara-btn-primary w-full" disabled={pending} onClick={() => run(() => patientRequestChange(p.token, reason))}>Ask the clinic to call me</button>
          <button className="cara-btn w-full" onClick={() => setMode("none")}>Back</button>
        </div>
      )}
    </div>
  );
}
