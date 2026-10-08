"use client";

// The appointment card (§3.2 "Cards and Flags for a Patient" — Zenoti's popover):
// patient, phone, flags, status with the moves allowed from here, service, time,
// branch, doctor and resources, notes, and reschedule / cancel. Loaded fresh from the
// server on open, with the privacy rule applied there — a masked appointment arrives
// with no patient in it at all.
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getAppointmentDetail,
  rescheduleFromDesk,
  setAppointmentStatus,
  setPatientFlag,
  slotsForBooking,
  type AppointmentDetail,
  type DeskResult,
  type SlotsForBooking,
} from "@/app/(dashboard)/appointments/actions";
import { FlagGlyph, IconAlert } from "@/components/Icon";
import { STATUS_ACTION, STATUS_LABEL, STATUS_TONE, fmtDay, fmtRange, fmtTime, keyOf } from "./ui";

/// Mounted fresh for each appointment opened (the desk keys it by id).
export function AppointmentCard({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<AppointmentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<DeskResult | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancel, setCancel] = useState<{ reason: string; by: "patient" | "clinic" }>({ reason: "", by: "patient" });
  const [moving, setMoving] = useState(false);
  const [move, setMove] = useState({ dateKey: "", reason: "" });
  const [slotState, setSlotState] = useState<{ key: string; slots: SlotsForBooking } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    getAppointmentDetail(id)
      .then((x) => live && setD(x))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id]);

  const slotKey = d ? `${d.branchId}|${d.typeId}|${d.doctor?.id ?? ""}|${move.dateKey}` : "";
  useEffect(() => {
    if (!moving || !d || !move.dateKey) return;
    let live = true;
    slotsForBooking({ branchId: d.branchId, typeId: d.typeId, doctorId: d.doctor?.id ?? "", dateKey: move.dateKey }).then(
      (s) => live && setSlotState({ key: slotKey, slots: s }),
    );
    return () => {
      live = false;
    };
  }, [moving, d, move.dateKey, slotKey]);
  const slots = moving && move.dateKey && slotState?.key === slotKey ? slotState.slots : null;

  const apptId = id;

  const reload = async () => {
    const fresh = await getAppointmentDetail(apptId);
    setD(fresh);
    router.refresh();
  };

  function status(to: string) {
    if (to === "cancelled") {
      setCancelling(true);
      return;
    }
    startTransition(async () => {
      const r = await setAppointmentStatus({ id: apptId, to });
      setMsg(r);
      if (r.ok) await reload();
    });
  }

  function doCancel() {
    startTransition(async () => {
      const r = await setAppointmentStatus({ id: apptId, to: "cancelled", reason: cancel.reason, cancelledBy: cancel.by });
      setMsg(r);
      if (r.ok) {
        setCancelling(false);
        await reload();
      }
    });
  }

  function doMove(ack = false) {
    if (!pick) return;
    startTransition(async () => {
      const r = await rescheduleFromDesk({ id: apptId, startAt: pick, reason: move.reason, acknowledgeWarnings: ack });
      setMsg(r);
      if (r.ok) {
        router.refresh();
        setTimeout(onClose, 700);
      }
    });
  }

  function toggleFlag(flagId: string, on: boolean) {
    if (!d?.patient) return;
    startTransition(async () => {
      const r = await setPatientFlag(d.patient!.id, flagId, on);
      if (r.ok) await reload();
      else setMsg({ ok: false, error: r.error });
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-16" onClick={onClose} role="dialog" aria-modal aria-label="Appointment">
      <div className="w-full max-w-[30rem] overflow-hidden rounded-xl bg-cara-page shadow-xl" onClick={(e) => e.stopPropagation()}>
        {loading || !d ? (
          <div className="p-6 text-cara-muted">{loading ? "Loading…" : "Appointment not found."}</div>
        ) : (
          <>
            <header className="space-y-2 bg-[var(--cara-ink)] p-5 text-white">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[17px] font-semibold">{d.patient?.name ?? "Booked"}</div>
                  {d.patient && <div className="text-[13px] opacity-80">{d.patient.phone}</div>}
                  {!d.visible && <div className="text-[12px] opacity-80">Another branch&rsquo;s appointment — details are visible to that branch only.</div>}
                </div>
                <button className="rounded px-2 py-1 text-[13px] opacity-80 hover:opacity-100" onClick={onClose} aria-label="Close">
                  Close
                </button>
              </div>
              {d.flagsEnabled && d.flags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {d.flags.map((f) => (
                    <button
                      key={f.id}
                      className={`tag ${f.on ? `tag-${f.tone}` : "tag-neutral"} ${f.on ? "" : "opacity-70"}`}
                      title={f.on ? `Remove ${f.label}` : `Mark ${f.label}`}
                      disabled={pending || !(d.canAct || d.canRunDay)}
                      onClick={() => toggleFlag(f.id, !f.on)}
                    >
                      <FlagGlyph icon={f.icon} className="tag-icon" />
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
              {d.canSeeLead && d.patient && (
                <Link href={`/leads/${d.patient.id}`} className="inline-block text-[12px] underline opacity-90">Open patient record</Link>
              )}
            </header>

            <div className="space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold uppercase tracking-wide text-cara-muted">Status</span>
                <span className={`tag tag-${STATUS_TONE[d.status] ?? "ink"}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
              </div>
              <div>
                <div className="font-medium text-cara-ink">{d.typeName ?? "Appointment"}</div>
                <div className="text-[13px] text-cara-muted">
                  {fmtDay(keyOf(d.startAt))}, {fmtRange(d.startAt, d.endAt)} · {d.branchName}
                </div>
                <div className="text-[13px] text-cara-muted">
                  {d.resources.map((r) => r.name).join(" · ")}
                </div>
              </div>
              {d.doctorOverbooked && (
                <div className="flex items-center gap-1.5 text-[12.5px] txt-warn">
                  <IconAlert /> Doctor double-booked (acknowledged at booking)
                </div>
              )}
              {d.overrideReason && <div className="text-[12.5px] txt-warn">Room clash overridden: {d.overrideReason}</div>}
              {d.rescheduledFrom && <div className="text-[12px] text-cara-faint">Moved from {fmtTime(d.rescheduledFrom)}, {fmtDay(keyOf(d.rescheduledFrom))}</div>}
              {d.cancelReason && <div className="text-[12.5px] text-cara-muted">Reason: {d.cancelReason}</div>}
              {d.notes && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-cara-muted">Notes</div>
                  <div className="text-[13px]">{d.notes}</div>
                </div>
              )}

              {/* Status moves */}
              {(d.canAct || d.canRunDay) && d.nextStatuses.length > 0 && !cancelling && !moving && (
                <div className="flex flex-wrap gap-2 border-t border-cara-rule pt-3">
                  {d.nextStatuses
                    .filter((s) => (["checked_in", "in_progress", "completed", "no_show"].includes(s) ? d.canRunDay : d.canAct))
                    .map((s) => (
                      <button key={s} className={`cara-btn ${s === "cancelled" || s === "no_show" ? "" : "cara-btn-primary"}`} disabled={pending} onClick={() => status(s)}>
                        {STATUS_ACTION[s] ?? s}
                      </button>
                    ))}
                  {d.canAct && ["tentative", "booked", "confirmed"].includes(d.status) && (
                    <button className="cara-btn" onClick={() => setMoving(true)}>Reschedule</button>
                  )}
                </div>
              )}

              {cancelling && (
                <div className="space-y-2 border-t border-cara-rule pt-3">
                  <div className="text-[13px] font-medium">Cancel this appointment</div>
                  <div className="flex gap-3 text-[13px]">
                    {(["patient", "clinic"] as const).map((by) => (
                      <label key={by} className="flex items-center gap-1">
                        <input type="radio" checked={cancel.by === by} onChange={() => setCancel({ ...cancel, by })} />
                        {by === "patient" ? "Patient cancelled" : "Clinic cancelled"}
                      </label>
                    ))}
                  </div>
                  <input className="cara-input" placeholder="Reason * (sick, travel, cost, clinic-initiated…)" value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} />
                  <div className="flex gap-2">
                    <button className="cara-btn cara-btn-danger" disabled={pending || !cancel.reason.trim()} onClick={doCancel}>Cancel appointment</button>
                    <button className="cara-btn" onClick={() => setCancelling(false)}>Keep it</button>
                  </div>
                </div>
              )}

              {moving && (
                <div className="space-y-2 border-t border-cara-rule pt-3">
                  <div className="text-[13px] font-medium">Move to</div>
                  <p className="cara-note text-[11.5px]">Same doctor; the room and team are found again for the new time.</p>
                  <input type="date" className="cara-input" value={move.dateKey} onChange={(e) => { setMove({ ...move, dateKey: e.target.value }); setPick(null); }} aria-label="New date" />
                  {move.dateKey && (slots === null ? (
                    <p className="cara-note text-[12px]">Loading…</p>
                  ) : slots.length === 0 ? (
                    <p className="cara-note text-[12px]">No free time that day.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {slots.map((s) => (
                        <button key={s.startAt} className={`tag ${pick === s.startAt ? "tag-klein" : s.needsAck ? "tag-citric" : "tag-aqua"}`} title={s.warnings.join("\n")} onClick={() => setPick(s.startAt)}>
                          {fmtTime(s.startAt)}
                        </button>
                      ))}
                    </div>
                  ))}
                  <input className="cara-input" placeholder="Reason (optional) — e.g. patient asked" value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} />
                  <div className="flex gap-2">
                    <button className="cara-btn cara-btn-primary" disabled={pending || !pick} onClick={() => doMove(false)}>Move appointment</button>
                    <button className="cara-btn" onClick={() => setMoving(false)}>Back</button>
                  </div>
                </div>
              )}

              {msg && !msg.ok && (
                <div className={`cara-notice ${msg.needsAck ? "is-warn" : "is-bad"} space-y-1`}>
                  <div>{msg.error}</div>
                  {msg.needsAck && (
                    <>
                      <ul className="list-disc pl-5 text-[12.5px]">
                        {msg.issues?.filter((i) => i.severity === "warn").map((w, i) => <li key={i}>{w.message}</li>)}
                      </ul>
                      <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => doMove(true)}>Confirm and move</button>
                    </>
                  )}
                </div>
              )}
              {msg?.ok && msg.info && <div className="cara-notice is-good">{msg.info}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
