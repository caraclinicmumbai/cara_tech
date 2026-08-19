"use client";

// The post-surgery care check-in schedule (§post-sales: day 1, 7, 30, 90 over WhatsApp).
//
// The important state to understand here is `blocked`: the system could NOT send
// automatically (no approved template, a safety flag, clinical consent withheld) and it
// is asking a person to do it. A post-op patient must never be quietly dropped, so a
// blocked check-in stays on this list, in amber, until someone closes it out.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CHECKIN_STATUS_LABELS, type CheckInStatus } from "@/lib/postSales/stages";
import { formatIst } from "@/lib/datetime";
import type { CheckInView } from "@/lib/postSales/board";
import { resolveCheckInAction, rescheduleCheckInAction } from "@/app/(dashboard)/post-sales/actions";

const TONE: Record<string, string> = {
  pending: "cara-badge",
  sent: "cara-badge cara-badge-success",
  done_manually: "cara-badge cara-badge-success",
  skipped: "cara-badge",
  blocked: "cara-badge cara-badge-warning",
  failed: "cara-badge cara-badge-danger",
};

function statusLabel(s: string): string {
  return CHECKIN_STATUS_LABELS[s as CheckInStatus] ?? s;
}

/// An ISO instant → `datetime-local` value in IST (the clinic's wall clock).
function istLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export function CheckInSchedule({
  journeyId,
  checkIns,
  surgeryAt,
  scheduleDays,
  automationOn,
  canManage,
}: {
  journeyId: string;
  checkIns: CheckInView[];
  surgeryAt: string | null;
  /// The day-offsets this treatment's policy calls for, so the panel can explain the
  /// schedule before surgery has even happened.
  scheduleDays: number[];
  automationOn: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /// The row being acted on, and which action — so only one form is open at a time.
  const [acting, setActing] = useState<{ id: string; kind: "skip" | "done" | "move" } | null>(null);
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong");
      else {
        setActing(null);
        setNote("");
        setWhen("");
        router.refresh();
      }
    });
  }

  function open(id: string, kind: "skip" | "done" | "move", currentIso: string) {
    setError(null);
    setActing({ id, kind });
    setNote("");
    setWhen(istLocalValue(currentIso));
  }

  const blockedCount = checkIns.filter((c) => c.status === "blocked" || c.status === "failed").length;

  return (
    <section className="cara-card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="cara-sec-hd">Care check-ins</h2>
        <span className="cara-note">
          Day {scheduleDays.join(" · ")} after surgery
          {blockedCount > 0 && (
            <>
              {" · "}
              <span className="text-warning">{blockedCount} need a person</span>
            </>
          )}
        </span>
      </div>

      <p className="cara-note">
        Medical care messages, not marketing — they go out even to a patient who opted out of promotions, governed by
        clinical consent. Coordinated across this patient&apos;s journeys so they never get two on one day.
      </p>

      {!automationOn && (
        <div className="cara-callout cara-callout-warning">
          Automated sending is off — work this list by hand and mark each one done.
        </div>
      )}

      {error && <div className="cara-callout cara-callout-danger">{error}</div>}

      {!surgeryAt ? (
        <p className="text-[13px] text-cara-faint">
          Nothing scheduled yet. The schedule is generated when the journey reaches Surgery Done and the surgery date is
          recorded.
        </p>
      ) : checkIns.length === 0 ? (
        <p className="text-[13px] text-cara-faint">No check-ins were generated for this journey.</p>
      ) : (
        <ul className="space-y-2">
          {checkIns.map((c) => {
            const open_ = acting?.id === c.id;
            const closed = c.status === "sent" || c.status === "done_manually" || c.status === "skipped";
            return (
              <li key={c.id} className="rounded-xl border border-cara-rule px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-cara-ink">
                      Day {c.dayOffset}
                      <span className={TONE[c.status] ?? "cara-badge"}>{statusLabel(c.status)}</span>
                    </div>
                    <div className="text-[12px] text-cara-muted">
                      {c.status === "sent" || c.status === "done_manually"
                        ? `${c.status === "sent" ? "Sent" : "Done"} ${c.sentAt ? formatIst(c.sentAt) : ""}`
                        : `Due ${formatIst(c.scheduledFor)}`}
                      {c.moved && (
                        <span className="text-cara-faint"> · moved from {formatIst(c.originalFor)}</span>
                      )}
                    </div>
                    {c.blockedReason && <div className="text-[12px] text-warning">{c.blockedReason}</div>}
                    {c.lastError && c.status === "failed" && (
                      <div className="text-[12px] text-danger">
                        Failed after {c.attempts} attempt{c.attempts === 1 ? "" : "s"}: {c.lastError}
                      </div>
                    )}
                    {c.deferredReason && !c.blockedReason && (
                      <div className="text-[11px] text-cara-faint">{c.deferredReason}</div>
                    )}
                    {c.note && <div className="text-[12px] text-cara-muted">Note: {c.note}</div>}
                  </div>

                  {canManage && !closed && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        className="cara-btn"
                        disabled={pending}
                        onClick={() => open(c.id, "done", c.scheduledFor)}
                      >
                        Done by hand
                      </button>
                      <button
                        type="button"
                        className="cara-btn"
                        disabled={pending}
                        onClick={() => open(c.id, "move", c.scheduledFor)}
                      >
                        Reschedule
                      </button>
                      <button
                        type="button"
                        className="cara-btn"
                        disabled={pending}
                        onClick={() => open(c.id, "skip", c.scheduledFor)}
                      >
                        Skip
                      </button>
                    </div>
                  )}
                </div>

                {open_ && acting && (
                  <div className="mt-2 space-y-2 border-t border-cara-rule pt-2">
                    {acting.kind === "move" ? (
                      <label className="block space-y-1">
                        <span className="cara-label">New date &amp; time (IST)</span>
                        <input
                          type="datetime-local"
                          className="cara-input"
                          value={when}
                          onChange={(e) => setWhen(e.target.value)}
                        />
                      </label>
                    ) : (
                      <label className="block space-y-1">
                        <span className="cara-label">
                          {acting.kind === "skip"
                            ? "Why is this being skipped? (required)"
                            : "What did you find? (optional)"}
                        </span>
                        <textarea
                          className="cara-textarea"
                          rows={2}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                      </label>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="cara-btn cara-btn-primary"
                        disabled={pending}
                        onClick={() =>
                          run(() =>
                            acting.kind === "move"
                              ? rescheduleCheckInAction({ journeyId, checkInId: c.id, scheduledFor: when })
                              : resolveCheckInAction({
                                  journeyId,
                                  checkInId: c.id,
                                  status: acting.kind === "skip" ? "skipped" : "done_manually",
                                  note: note || null,
                                }),
                          )
                        }
                      >
                        {pending ? "Saving…" : "Confirm"}
                      </button>
                      <button type="button" className="cara-btn" disabled={pending} onClick={() => setActing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
