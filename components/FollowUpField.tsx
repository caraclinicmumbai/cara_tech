"use client";

// The lead's next follow-up date and time (§follow-up). One control, on the step the
// leads-table "Follow up" column already reads, so setting it here moves that column.
//
// The value is IST wall-clock — what the clinic means by "3:30 pm" — not the browser's
// local time. The server parses it the same way, so a counsellor on a laptop set to the
// wrong timezone still books the slot they typed.
import { useState, useTransition } from "react";
import { setLeadFollowUp } from "@/app/(dashboard)/leads/followUpActions";

export function FollowUpField({
  leadId,
  dueAtLocal,
  title,
  overdue,
  laterCount,
  laterFirst,
}: {
  leadId: string;
  /// "YYYY-MM-DDTHH:mm" in IST, or "" when nothing is scheduled.
  dueAtLocal: string;
  /// What the step is called, shown so it's clear WHICH follow-up is being moved.
  title: string | null;
  overdue: boolean;
  /// How many further follow-ups are queued behind this one, and when the soonest of
  /// them falls. Without this, pushing the next date past a queued step makes the
  /// field come back showing that step's date — which reads as "my change didn't save".
  laterCount: number;
  laterFirst: string | null;
}) {
  const [value, setValue] = useState(dueAtLocal);
  const [saved, setSaved] = useState(dueAtLocal);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function commit(next: string) {
    if (next === saved) return;
    setMsg(null);
    startTransition(async () => {
      const res = await setLeadFollowUp({ leadId, dueAt: next });
      if (res.ok) {
        setSaved(next);
        setMsg({ kind: "ok", text: res.info ?? "Saved" });
      } else {
        // Put the field back to what's actually stored, so the screen never shows a
        // date the server rejected.
        setValue(saved);
        setMsg({ kind: "err", text: res.error ?? "Could not save" });
      }
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="datetime-local"
          aria-label="Next follow-up date and time"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="cara-input py-1 text-[13px]"
        />
        {value && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setValue("");
              commit("");
            }}
            className="cara-btn py-1 text-[12px]"
          >
            Clear
          </button>
        )}
        {pending && <span className="text-[12px] text-cara-faint">Saving…</span>}
      </div>

      <p className="text-[11px] text-cara-faint">
        {title ? (
          <>
            Moves <span className="text-cara-muted">{title}</span> — the date shown in the
            leads table.
          </>
        ) : (
          "Nothing scheduled. Setting a date adds a follow-up owned by this lead's counsellor."
        )}
        {overdue && !pending && <span className="ml-1 text-danger">Currently overdue.</span>}
        <span className="ml-1">Times are IST.</span>
      </p>

      {/* Say what's queued behind this one. Otherwise pushing this date past the next
          step makes the field reload showing that step instead, which reads as a
          failed save rather than as "something else is now sooner". */}
      {laterCount > 0 && (
        <p className="text-[11px] text-cara-faint">
          {laterCount} more follow-up{laterCount === 1 ? "" : "s"} scheduled after this
          {laterFirst ? <> — next on {laterFirst}</> : null}. Push this one past{" "}
          {laterFirst ?? "them"} and that one becomes the lead&rsquo;s next follow-up.
        </p>
      )}

      {msg && (
        <p className={`text-[12px] ${msg.kind === "ok" ? "text-success" : "text-danger"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
