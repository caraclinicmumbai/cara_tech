"use client";

// The "needs rebooking" worklist (§2.9). For each case: who, when, why, owner, due —
// "Show options" fetches the system's suggestions (same doctor later here, another
// doctor same time here, same doctor at another branch); applying one reschedules and
// messages the patient. "Patient declined — call required" and closing by hand too.
import { useState } from "react";
import { applyOption, optionsForCase, updateCase } from "@/app/(dashboard)/appointments/rebooking/actions";
import type { RebookOption } from "@/lib/scheduling/conflicts";
import { Msg, useRun } from "./useRun";

export type CaseRow = {
  id: string;
  status: string;
  cause: string;
  reason: string;
  urgent: boolean;
  overdue: boolean;
  due: string;
  patient: string;
  phone: string;
  when: string;
  branch: string;
  service: string;
  doctor: string | null;
  owner: string | null;
  note: string | null;
  canAct: boolean;
};

const STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "needs rebooking", tone: "tangerine" },
  proposed: { label: "moved — confirm with patient", tone: "blue" },
  patient_declined: { label: "patient declined — call required", tone: "fushia" },
  resolved: { label: "resolved", tone: "aqua" },
  dismissed: { label: "dismissed", tone: "neutral" },
};

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

function Case({ c }: { c: CaseRow }) {
  const { run, pending, msg, setMsg } = useRun();
  const [options, setOptions] = useState<RebookOption[] | null>(null);
  const [note, setNote] = useState("");
  const live = ["open", "proposed", "patient_declined"].includes(c.status);
  const s = STATUS[c.status] ?? { label: c.status, tone: "ink" };

  function loadOptions() {
    setMsg(null);
    run(async () => {
      const r = await optionsForCase(c.id);
      if (!r.ok) return { ok: false, error: r.error };
      setOptions(r.options);
      return { ok: true, info: r.options.length ? undefined : "No alternatives found in the next three weeks — call the patient." };
    });
  }

  return (
    <div className={`cara-card space-y-2 p-4 ${c.overdue ? "border-l-4 border-l-[#ef5b3c]" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-cara-ink">{c.patient}</span>
        <a href={`tel:${c.phone}`} className="text-[12.5px] tone-link">{c.phone}</a>
        <span className={`tag tag-${s.tone}`}>{s.label}</span>
        {c.urgent && live && <span className="tag tag-tangerine">urgent</span>}
        {c.overdue && <span className="text-[12px] font-medium txt-bad">overdue</span>}
      </div>
      <div className="text-[12.5px] text-cara-muted">
        {c.service} · {c.when} · {c.branch}{c.doctor ? ` · ${c.doctor}` : ""}
      </div>
      <div className="text-[12.5px]">
        <span className="font-medium">Why:</span> {c.reason}
      </div>
      <div className="text-[11.5px] text-cara-faint">
        Owner: {c.owner ?? "unassigned (no branch manager)"} · due {c.due}
        {c.note ? ` · ${c.note}` : ""}
      </div>

      {live && c.canAct && (
        <div className="space-y-2 border-t border-cara-rule pt-2">
          <div className="flex flex-wrap gap-2">
            {c.status !== "proposed" && (
              <button className="cara-btn cara-btn-primary" disabled={pending} onClick={loadOptions}>
                {options ? "Refresh options" : "Show options"}
              </button>
            )}
            {c.status === "proposed" && (
              <>
                <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => updateCase(c.id, "resolved", "Patient confirmed the new time"))}>
                  Patient confirmed
                </button>
                <button className="cara-btn" disabled={pending} onClick={() => run(() => updateCase(c.id, "patient_declined", "Patient declined the new time"))}>
                  Patient declined — call required
                </button>
              </>
            )}
            {c.status === "open" && (
              <button className="cara-btn" disabled={pending} onClick={() => run(() => updateCase(c.id, "patient_declined", "Patient declined — call required"))}>
                Patient declined — call required
              </button>
            )}
            <input className="cara-input w-56!" placeholder="Note (required to dismiss)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="cara-btn" disabled={pending} onClick={() => run(() => updateCase(c.id, "resolved", note || "Handled by phone"))}>Resolved by phone</button>
            <button className="cara-btn" disabled={pending} onClick={() => run(() => updateCase(c.id, "dismissed", note))}>Dismiss</button>
          </div>
          {options && options.length > 0 && (
            <div className="space-y-1.5">
              {options.map((o, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--cara-surface-2)] px-3 py-2 text-[12.5px]">
                  <span className="font-medium">{o.label}</span>
                  <span>{fmt.format(new Date(o.startAt))} · {o.branchName}</span>
                  <button
                    className="cara-btn ml-auto"
                    disabled={pending}
                    onClick={() => confirm(`Move ${c.patient} to ${fmt.format(new Date(o.startAt))} at ${o.branchName}${o.doctorName ? ` with ${o.doctorName}` : ""}, and message the patient?`) && run(() => applyOption(c.id, o))}
                  >
                    Move &amp; tell patient
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}

export function RebookingList({ cases }: { cases: CaseRow[] }) {
  const live = cases.filter((c) => ["open", "proposed", "patient_declined"].includes(c.status));
  const done = cases.filter((c) => !["open", "proposed", "patient_declined"].includes(c.status));
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="cara-eyebrow">To handle ({live.length})</h2>
        {live.length === 0 && <p className="cara-note">Nothing needs rebooking.</p>}
        {live.map((c) => (
          <Case key={c.id} c={c} />
        ))}
      </section>
      {done.length > 0 && (
        <section className="space-y-3">
          <h2 className="cara-eyebrow">Closed in the last 7 days ({done.length})</h2>
          {done.map((c) => (
            <Case key={c.id} c={c} />
          ))}
        </section>
      )}
    </div>
  );
}
