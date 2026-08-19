"use client";

// The clinical stage panel (§post-sales). The stepper, the stage clock, the surgery
// date, and the three assignment slots — everything the post-sales team touches to move
// a treatment forward.
//
// Read-only for anyone without `postsales.manage` (which is every sales counsellor):
// "The Post-Sales team owns these stages. Sales counsellors can't edit them."
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  JOURNEY_STAGES,
  JOURNEY_STAGE_LABELS,
  JOURNEY_STAGE_HINTS,
  SURGERY_STAGE,
  TERMINAL_JOURNEY_STAGE,
  isBackwardMove,
  journeyStageIndex,
  type JourneyStage,
} from "@/lib/postSales/stages";
import { formatIst, formatIstDate } from "@/lib/datetime";
import { moveStage, updateSurgeryDate, assignStaff } from "@/app/(dashboard)/post-sales/actions";

type Staff = { id: string; name: string };

const ROLE_META: { key: "doctor" | "otLead" | "consultant"; label: string; hint: string }[] = [
  { key: "doctor", label: "Doctor / surgeon", hint: "Performs and signs off the procedure" },
  { key: "otLead", label: "OT lead", hint: "Owns pre-op prep and the theatre slot" },
  { key: "consultant", label: "Post-sales consultant", hint: "Owns the patient relationship and check-ins" },
];

/// An ISO instant → the `datetime-local` value for that instant in IST, which is what
/// the clinic types and reads. Doing this naively (toISOString().slice) would show UTC
/// and read 5h30m early.
function istLocalValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/// "Now" as a `datetime-local` value in IST — the sensible default when the OT team
/// records a surgery that just happened. Module scope, and only ever called from an
/// event handler, never during render.
function nowIstLocal(): string {
  return istLocalValue(new Date().toISOString());
}

export function JourneyStagePanel({
  journeyId,
  stage,
  stageDueAt,
  daysInStage,
  daysOverdue,
  overdue,
  surgeryAt,
  staff,
  assigned,
  canManage,
}: {
  journeyId: string;
  stage: string;
  stageDueAt: string | null;
  daysInStage: number;
  daysOverdue: number;
  overdue: boolean;
  surgeryAt: string | null;
  staff: { doctors: Staff[]; otTeam: Staff[]; consultants: Staff[] };
  assigned: { doctor: string | null; otLead: string | null; consultant: string | null };
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The move being composed. A backward move needs a reason; entering Surgery Done needs
  // a date; closing takes an optional sign-off note.
  const [target, setTarget] = useState<JourneyStage | null>(null);
  const [reason, setReason] = useState("");
  const [surgeryInput, setSurgeryInput] = useState(() => istLocalValue(surgeryAt));

  const currentIndex = journeyStageIndex(stage);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong");
      else {
        after?.();
        router.refresh();
      }
    });
  }

  function chooseStage(next: JourneyStage) {
    setError(null);
    const backward = isBackwardMove(stage, next);
    const needsSurgeryDate = next === SURGERY_STAGE && !surgeryAt;
    // A move that needs more input opens the form; a plain forward step just goes.
    if (backward || needsSurgeryDate || next === TERMINAL_JOURNEY_STAGE) {
      setTarget(next);
      setReason("");
      if (needsSurgeryDate && !surgeryInput) setSurgeryInput(nowIstLocal());
      return;
    }
    run(() => moveStage({ journeyId, stage: next }));
  }

  function submitMove() {
    if (!target) return;
    run(
      () =>
        moveStage({
          journeyId,
          stage: target,
          reason: reason || null,
          surgeryAt: target === SURGERY_STAGE ? surgeryInput || null : null,
          closedNote: target === TERMINAL_JOURNEY_STAGE ? reason || null : null,
        }),
      () => {
        setTarget(null);
        setReason("");
      },
    );
  }

  const backwardTarget = target ? isBackwardMove(stage, target) : false;

  return (
    <section className="cara-card space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="cara-sec-hd">Clinical stage</h2>
        <span className="cara-note">
          {daysInStage}d in {JOURNEY_STAGE_LABELS[stage as JourneyStage] ?? stage}
          {stageDueAt && (
            <>
              {" · "}
              {overdue ? (
                <span className="text-danger">
                  limit passed {daysOverdue > 0 ? `${daysOverdue}d ago` : "today"} ({formatIstDate(stageDueAt)})
                </span>
              ) : (
                <>due by {formatIstDate(stageDueAt)}</>
              )}
            </>
          )}
          {!stageDueAt && " · no time limit"}
        </span>
      </div>

      {/* The stepper. Completed stages are filled, the current one is ringed. */}
      <ol className="flex flex-wrap gap-2">
        {JOURNEY_STAGES.map((s, i) => {
          const done = i < currentIndex;
          const current = i === currentIndex;
          const tone = current
            ? "border-cara-accent bg-cara-accent/10 text-cara-ink font-semibold"
            : done
              ? "border-cara-rule bg-cara-tint text-cara-muted"
              : "border-dashed border-cara-rule text-cara-faint";
          return (
            <li key={s}>
              <button
                type="button"
                disabled={!canManage || pending || current}
                onClick={() => chooseStage(s)}
                title={JOURNEY_STAGE_HINTS[s]}
                className={`rounded-xl border px-3 py-1.5 text-[12px] transition-colors ${tone} ${
                  canManage && !current ? "hover:border-cara-accent" : "cursor-default"
                } disabled:cursor-not-allowed`}
              >
                {done && "✓ "}
                {JOURNEY_STAGE_LABELS[s]}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="cara-note">{JOURNEY_STAGE_HINTS[stage as JourneyStage]}</p>

      {error && <div className="cara-callout cara-callout-danger">{error}</div>}

      {/* The confirm form for a move that needs more than a click. */}
      {target && canManage && (
        <div className="cara-callout cara-callout-info space-y-2">
          <div className="font-semibold">
            Move to {JOURNEY_STAGE_LABELS[target]}
            {backwardTarget && " (going back)"}
          </div>

          {target === SURGERY_STAGE && (
            <label className="block space-y-1">
              <span className="cara-label">Surgery date &amp; time (IST)</span>
              <input
                type="datetime-local"
                className="cara-input"
                value={surgeryInput}
                onChange={(e) => setSurgeryInput(e.target.value)}
              />
              <span className="block text-[11px] opacity-80">
                The day 1 / 7 / 30 / 90 check-in schedule is generated from this.
              </span>
            </label>
          )}

          <label className="block space-y-1">
            <span className="cara-label">
              {backwardTarget
                ? "Why is this going back? (required — it goes in the permanent log)"
                : target === TERMINAL_JOURNEY_STAGE
                  ? "Sign-off note (optional)"
                  : "Note (optional)"}
            </span>
            <textarea className="cara-textarea" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </label>

          <div className="flex gap-2">
            <button type="button" className="cara-btn cara-btn-primary" disabled={pending} onClick={submitMove}>
              {pending ? "Saving…" : "Confirm"}
            </button>
            <button type="button" className="cara-btn" disabled={pending} onClick={() => setTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Surgery date, once recorded — correctable, and correcting it re-anchors the
          un-sent check-ins. */}
      {surgeryAt && (
        <div className="space-y-1 border-t border-cara-rule pt-3">
          <div className="cara-label">Surgery</div>
          <div className="text-[13px]">{formatIst(surgeryAt)}</div>
          {canManage && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-cara-muted hover:text-cara-ink">Correct this date</summary>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <input
                  type="datetime-local"
                  className="cara-input"
                  value={surgeryInput}
                  onChange={(e) => setSurgeryInput(e.target.value)}
                />
                <button
                  type="button"
                  className="cara-btn"
                  disabled={pending || !surgeryInput}
                  onClick={() => run(() => updateSurgeryDate({ journeyId, surgeryAt: surgeryInput }))}
                >
                  Save &amp; re-anchor check-ins
                </button>
              </div>
              <p className="mt-1 text-[11px] text-cara-faint">
                Check-ins that have already gone out are left alone; the rest are rescheduled from the new date.
              </p>
            </details>
          )}
        </div>
      )}

      {/* The clinical team. */}
      <div className="grid gap-3 border-t border-cara-rule pt-3 sm:grid-cols-3">
        {ROLE_META.map((r) => {
          const options =
            r.key === "doctor" ? staff.doctors : r.key === "otLead" ? staff.otTeam : staff.consultants;
          const value = assigned[r.key] ?? "";
          return (
            <label key={r.key} className="space-y-1">
              <span className="cara-label">{r.label}</span>
              {canManage ? (
                <select
                  className="cara-select"
                  value={value}
                  disabled={pending}
                  onChange={(e) => run(() => assignStaff({ journeyId, role: r.key, userId: e.target.value || null }))}
                >
                  <option value="">Unassigned</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-[13px]">
                  {options.find((o) => o.id === value)?.name ?? <span className="text-cara-faint">Unassigned</span>}
                </div>
              )}
              <span className="block text-[11px] text-cara-faint">{r.hint}</span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
