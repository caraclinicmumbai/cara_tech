"use client";

// The lead's next follow-up date and time (§follow-up). One control, on the step the
// leads-table "Follow up" column already reads, so setting it here moves that column.
//
// **Why this isn't `<input type="datetime-local">` any more.** The native control renders
// in whatever format the browser and OS locale decide — the desk got a 24-hour clock and
// a time spinner they couldn't scroll. A date input plus three plain `<select>`s gives
// the same value with a 12-hour clock and AM/PM everywhere, and a select is a native
// scrollable list on every platform, keyboard included.
//
// The value is IST wall-clock — what the clinic means by "3:30 pm" — not the browser's
// local time. The server parses it the same way, so a counsellor on a laptop set to the
// wrong timezone still books the slot they typed.
import { useState, useTransition } from "react";
import { setLeadFollowUp } from "@/app/(dashboard)/leads/followUpActions";

/// Minute granularity offered. Five minutes is finer than any clinic books to, and keeps
/// the list short enough to pick from without scrolling far.
const MINUTES = ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"];
const HOURS12 = ["12", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"];

/// The default time when someone picks a date but no time — mid-morning, when the clinic
/// is open and calls get answered. Better than midnight, which reads as "no time set"
/// and lands the reminder while everyone is asleep.
const DEFAULT_HOUR_24 = 10;

export type Parts = { date: string; hour12: string; minute: string; meridiem: "AM" | "PM" };

/// "YYYY-MM-DDTHH:mm" (24h, IST) → the four pieces the controls show.
export function toParts(value: string): Parts {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return { date: "", hour12: "10", minute: "00", meridiem: "AM" };
  const [, date, hh, mm] = m;
  const h = Number(hh);
  return {
    date,
    hour12: String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0"),
    // Snap to the nearest offered minute so an existing 11:37 doesn't show as blank.
    minute: MINUTES.includes(mm) ? mm : MINUTES[Math.round(Number(mm) / 5) % 12],
    meridiem: h >= 12 ? "PM" : "AM",
  };
}

/// The four pieces → "YYYY-MM-DDTHH:mm" (24h, IST), or "" when there's no date.
export function fromParts(p: Parts): string {
  if (!p.date) return "";
  let h = Number(p.hour12) % 12;
  if (p.meridiem === "PM") h += 12;
  return `${p.date}T${String(h).padStart(2, "0")}:${p.minute}`;
}

export function FollowUpField({
  leadId,
  dueAtLocal,
  title,
  overdue,
}: {
  leadId: string;
  /// "YYYY-MM-DDTHH:mm" in IST, or "" when nothing is scheduled.
  dueAtLocal: string;
  /// What the step is called, shown so it's clear WHICH follow-up is being moved.
  title: string | null;
  overdue: boolean;
}) {
  const [parts, setParts] = useState<Parts>(() => toParts(dueAtLocal));
  const [saved, setSaved] = useState(dueAtLocal);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function commit(next: Parts) {
    const value = fromParts(next);
    if (value === saved) return;
    setMsg(null);
    startTransition(async () => {
      const res = await setLeadFollowUp({ leadId, dueAt: value });
      if (res.ok) {
        setSaved(value);
        setMsg({ kind: "ok", text: res.info ?? "Saved" });
      } else {
        // Put the controls back to what's actually stored, so the screen never shows a
        // time the server rejected.
        setParts(toParts(saved));
        setMsg({ kind: "err", text: res.error ?? "Could not save" });
      }
    });
  }

  /// Change one piece and save. Picking a date with no time yet gets the default hour,
  /// so a single click books something sensible rather than midnight.
  function update(patch: Partial<Parts>) {
    const seeded: Partial<Parts> =
      patch.date && !parts.date
        ? {
            hour12: String(DEFAULT_HOUR_24 % 12 === 0 ? 12 : DEFAULT_HOUR_24 % 12).padStart(2, "0"),
            minute: "00",
            meridiem: DEFAULT_HOUR_24 >= 12 ? "PM" : "AM",
          }
        : {};
    const next = { ...parts, ...seeded, ...patch } as Parts;
    setParts(next);
    commit(next);
  }

  /// The step being moved, said in a few words on the row with the full sentence on
  /// hover. Any later follow-ups are listed under this field (FollowUpList), so pushing
  /// this date past one of them visibly makes that one the next.
  const scheduleHint = title
    ? `Moves “${title}” — the date the leads table shows.`
    : "Nothing scheduled. Setting a date adds a follow-up owned by this lead's counsellor.";

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1.5">
        <input
          type="date"
          aria-label="Next follow-up date"
          title={scheduleHint}
          value={parts.date}
          disabled={pending}
          onChange={(e) => update({ date: e.target.value })}
          className="cara-input cara-control-compact"
        />

        {/* Only ask for a time once there's a day to put it on. */}
        {parts.date && (
          <>
            <TimeSelects parts={parts} disabled={pending} onChange={update} />
            <span className="text-[11px] text-cara-faint" title="Times are IST.">
              IST
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => update({ date: "" })}
              className="cara-btn cara-control-compact"
            >
              Clear
            </button>
          </>
        )}
      </span>

      <span className="flex items-center gap-2 text-[11px] text-cara-faint">
        {pending && <span>Saving…</span>}

        {!pending && msg && (
          <span className={msg.kind === "ok" ? "text-success" : "text-danger"}>{msg.text}</span>
        )}

        {!pending && !msg && overdue && (
          <span className="text-danger" title="This follow-up date has already passed.">
            Overdue
          </span>
        )}

        {!pending && !msg && !overdue && (
          <span className="max-w-88 truncate" title={scheduleHint}>
            {title ?? "Nothing scheduled"}
          </span>
        )}
      </span>
    </span>
  );
}

/// Hour, minute and AM/PM as plain selects (see the note at the top of this file).
export function TimeSelects({
  parts,
  disabled,
  onChange,
}: {
  parts: Parts;
  disabled?: boolean;
  onChange: (patch: Partial<Parts>) => void;
}) {
  const sel = "cara-select cara-control-compact";
  return (
    <>
      <select aria-label="Hour" value={parts.hour12} disabled={disabled} onChange={(e) => onChange({ hour12: e.target.value })} className={sel}>
        {HOURS12.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className="text-cara-muted">:</span>
      <select aria-label="Minute" value={parts.minute} disabled={disabled} onChange={(e) => onChange({ minute: e.target.value })} className={sel}>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select
        aria-label="AM or PM"
        value={parts.meridiem}
        disabled={disabled}
        onChange={(e) => onChange({ meridiem: e.target.value as "AM" | "PM" })}
        className={sel}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </>
  );
}
