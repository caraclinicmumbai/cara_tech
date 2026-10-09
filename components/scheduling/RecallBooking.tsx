"use client";

// The patient books a due treatment-plan session (§2.8) from their recall link.
import { useEffect, useState, useTransition } from "react";
import { recallBook, recallSlots } from "@/app/(public)/r/[token]/actions";

const TZ = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const addDays = (k: string, n: number) => {
  const d = new Date(`${k}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
};

export function RecallBooking(p: {
  token: string;
  firstName: string;
  label: string;
  planName: string;
  dueFrom: string;
  dueTo: string;
  today: string;
  branches: { id: string; name: string }[];
  defaultBranch: string;
}) {
  // Inside the window; if the window has passed (overdue), the next 30 days.
  const first = p.dueFrom > p.today ? p.dueFrom : p.today;
  const last = p.dueTo >= p.today ? p.dueTo : addDays(p.today, 30);
  const days: string[] = [];
  for (let d = first; d <= last && days.length < 45; d = addDays(d, 1)) days.push(d);
  const [branch, setBranch] = useState(p.defaultBranch);
  const [day, setDay] = useState(days[0]);
  const [slots, setSlots] = useState<{ key: string; list: { startAt: string }[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key = `${branch}|${day}`;

  useEffect(() => {
    if (!day) return;
    let live = true;
    recallSlots(p.token, branch, day).then((list) => live && setSlots({ key, list }));
    return () => {
      live = false;
    };
  }, [p.token, branch, day, key]);
  const list = slots?.key === key ? slots.list : null;

  if (done) {
    return (
      <div className="cara-card space-y-2 p-5">
        <div className="text-[17px] font-semibold">Booked — thank you</div>
        <p className="text-[13px] text-cara-muted">You can confirm, reschedule or cancel from this link:</p>
        <a href={done} className="block break-all text-[13px] underline">{done}</a>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="cara-card space-y-1 p-5">
        <div className="text-[13px] text-cara-muted">Hi {p.firstName},</div>
        <div className="text-[17px] font-semibold text-cara-ink">{p.label}</div>
        <div className="text-[13.5px]">
          Part of your {p.planName}. Due {dayFmt.format(new Date(`${p.dueFrom}T12:00:00+05:30`))} – {dayFmt.format(new Date(`${p.dueTo}T12:00:00+05:30`))}.
        </div>
      </div>
      <div className="cara-card space-y-3 p-5">
        {p.branches.length > 1 && (
          <select className="cara-select" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Clinic">
            {p.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {days.map((d) => (
            <button key={d} className={`cara-chip shrink-0 ${day === d ? "on" : ""}`} onClick={() => setDay(d)}>
              {dayFmt.format(new Date(`${d}T12:00:00+05:30`))}
            </button>
          ))}
        </div>
        {list === null ? (
          <p className="text-[13px] text-cara-muted">Finding free times…</p>
        ) : list.length === 0 ? (
          <p className="text-[13px] text-cara-muted">No free times this day — try another.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {list.map((s) => (
              <button
                key={s.startAt}
                className="cara-btn"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await recallBook(p.token, branch, s.startAt);
                    if (r.ok && r.link) setDone(r.link);
                    else setError(r.error ?? "Couldn't book");
                  })
                }
              >
                {timeFmt.format(new Date(s.startAt))}
              </button>
            ))}
          </div>
        )}
        {error && <div className="cara-notice is-bad">{error}</div>}
      </div>
    </div>
  );
}
