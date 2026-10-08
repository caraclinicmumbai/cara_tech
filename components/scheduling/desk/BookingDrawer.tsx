"use client";

// Book an appointment from the desk (§3.2 / §2.1 / §2.2). Patient → treatment →
// named doctor → day → a free slot (or the time clicked on the calendar) → book.
// Whatever the server answers is shown as it is: warnings to confirm (busy doctor or
// machine), an override box for a branch manager on a consultation-room clash, or
// "that slot was just taken".
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  bookFromDesk,
  createPatient,
  searchPatients,
  slotsForBooking,
  type DeskResult,
  type PatientHit,
  type SlotsForBooking,
} from "@/app/(dashboard)/appointments/actions";
import { IconAlert } from "@/components/Icon";
import type { DeskViewer, Opt, TypeOpt } from "./types";
import { fmtDay, fmtRange, fmtTime, keyOf } from "./ui";

export type BookingPrefill = {
  branchId?: string;
  typeId?: string;
  doctorId?: string;
  dateKey?: string;
  startAt?: string; // a specific time (clicked on the calendar / picked in Find a slot)
};

/// Mounted fresh for every opening (the desk gives it a new key), so its state starts
/// from the prefill with no reset effects.
export function BookingDrawer({
  onClose,
  prefill,
  branches,
  types,
  doctors,
  viewer,
}: {
  onClose: () => void;
  prefill: BookingPrefill;
  branches: Opt[];
  types: TypeOpt[];
  doctors: Opt[];
  viewer: DeskViewer;
}) {
  const router = useRouter();
  const allowedBranches = viewer.bookAnyBranch ? branches : branches.filter((b) => b.id === viewer.homeBranchId);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [newPt, setNewPt] = useState<{ name: string; phone: string } | null>(null);
  const [form, setForm] = useState({
    branchId: prefill.branchId ?? allowedBranches[0]?.id ?? "",
    typeId: prefill.typeId ?? types[0]?.id ?? "",
    doctorId: prefill.doctorId ?? "",
    dateKey: prefill.dateKey ?? "",
    notes: "",
  });
  const [startAt, setStartAt] = useState<string | null>(prefill.startAt ?? null);
  // Slots are remembered against the query that produced them, so a stale list never
  // shows for a different day/doctor — derived, rather than cleared in an effect.
  const [slotState, setSlotState] = useState<{ key: string; slots: SlotsForBooking } | null>(null);
  const [result, setResult] = useState<DeskResult | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [pending, startTransition] = useTransition();
  const type = types.find((t) => t.id === form.typeId);

  // Patient search (debounced). Short queries show nothing — derived below.
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = setTimeout(() => {
      searchPatients(q).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const shownHits = q.trim().length >= 2 ? hits : [];

  // Free slots for the chosen day.
  const ready = !!(form.branchId && form.typeId && form.dateKey && (!type?.needsDoctor || form.doctorId));
  const slotKey = `${form.branchId}|${form.typeId}|${form.doctorId}|${form.dateKey}`;
  const [slotVersion, setSlotVersion] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    slotsForBooking({ branchId: form.branchId, typeId: form.typeId, doctorId: form.doctorId, dateKey: form.dateKey })
      .then((s) => live && setSlotState({ key: slotKey, slots: s }))
      .catch(() => live && setSlotState({ key: slotKey, slots: [] }));
    return () => {
      live = false;
    };
  }, [ready, slotKey, form.branchId, form.typeId, form.doctorId, form.dateKey, slotVersion]);
  const slots = ready && slotState?.key === slotKey ? slotState.slots : null;

  function book(opts: { ack?: boolean; override?: boolean } = {}) {
    if (!patient || !startAt) return;
    setResult(null);
    startTransition(async () => {
      const r = await bookFromDesk({
        leadId: patient.id,
        branchId: form.branchId,
        typeId: form.typeId,
        doctorId: form.doctorId,
        startAt,
        notes: form.notes,
        acknowledgeWarnings: opts.ack,
        overrideReason: opts.override ? overrideReason : null,
      });
      setResult(r);
      if (r.ok) {
        router.refresh();
        setTimeout(onClose, 700);
      } else if (r.justTaken) {
        // Refetch the slot list so the taken time disappears.
        setSlotVersion((v) => v + 1);
        setStartAt(null);
      }
    });
  }

  function addPatient() {
    if (!newPt) return;
    startTransition(async () => {
      const r = await createPatient(newPt);
      if (r.ok && r.patient) {
        setPatient(r.patient);
        setNewPt(null);
        setResult(r.existed ? { ok: true, info: "That number is already a patient — selected them instead of creating a duplicate." } : null);
      } else setResult({ ok: false, error: r.error });
    });
  }

  const warnings = result?.issues?.filter((i) => i.severity === "warn") ?? [];
  const blocks = result?.issues?.filter((i) => i.severity === "block") ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose} role="dialog" aria-modal aria-label="Book an appointment">
      <div className="h-full w-full max-w-[34rem] overflow-y-auto bg-cara-page p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="cara-title">New appointment</h2>
          <button className="cara-btn" onClick={onClose}>Close</button>
        </div>

        <div className="space-y-4">
          {/* 1. Patient */}
          <section className="cara-card space-y-2 p-4">
            <div className="cara-eyebrow">Patient</div>
            {patient ? (
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-cara-ink">{patient.name}</div>
                  <div className="text-[12px] text-cara-muted">phone ending {patient.phoneTail}{patient.flags.length ? ` · ${patient.flags.join(", ")}` : ""}</div>
                </div>
                <button className="cara-btn" onClick={() => setPatient(null)}>Change</button>
              </div>
            ) : newPt ? (
              <div className="space-y-2">
                <input className="cara-input" placeholder="Full name *" value={newPt.name} onChange={(e) => setNewPt({ ...newPt, name: e.target.value })} />
                <input className="cara-input" placeholder="Mobile number *" value={newPt.phone} onChange={(e) => setNewPt({ ...newPt, phone: e.target.value })} />
                <div className="flex gap-2">
                  <button className="cara-btn cara-btn-primary" disabled={pending} onClick={addPatient}>Add patient</button>
                  <button className="cara-btn" onClick={() => setNewPt(null)}>Back to search</button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <input className="cara-input" placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                {shownHits.length > 0 && (
                  <ul className="max-h-56 divide-y divide-[var(--cara-rule)] overflow-y-auto rounded border border-cara-rule">
                    {shownHits.map((h) => (
                      <li key={h.id}>
                        <button className="w-full px-3 py-2 text-left hover:bg-[var(--cara-surface-2)]" onClick={() => setPatient(h)}>
                          <span className="font-medium">{h.name}</span>{" "}
                          <span className="text-[12px] text-cara-muted">· …{h.phoneTail}{h.flags.length ? ` · ${h.flags.join(", ")}` : ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {q.trim().length >= 2 && shownHits.length === 0 && <p className="cara-note text-[12px]">No match.</p>}
                <button className="cara-btn" onClick={() => setNewPt({ name: q.match(/\d/) ? "" : q, phone: q.match(/\d/) ? q : "" })}>
                  + New patient
                </button>
              </div>
            )}
          </section>

          {/* 2. What, where, who, when */}
          <section className="cara-card space-y-2 p-4">
            <div className="cara-eyebrow">Appointment</div>
            <select className="cara-select" value={form.branchId} onChange={(e) => { setForm({ ...form, branchId: e.target.value }); setStartAt(null); }} aria-label="Branch">
              {allowedBranches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            {!viewer.bookAnyBranch && <p className="cara-note text-[11.5px]">You book at your own branch. The call centre or a branch manager can book elsewhere.</p>}
            <select className="cara-select" value={form.typeId} onChange={(e) => { setForm({ ...form, typeId: e.target.value }); setStartAt(null); }} aria-label="Treatment">
              {types.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            {type?.needsDoctor && (
              <select className="cara-select" value={form.doctorId} onChange={(e) => { setForm({ ...form, doctorId: e.target.value }); setStartAt(null); }} aria-label="Doctor">
                <option value="">Choose the doctor *</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            <input type="date" className="cara-input" value={form.dateKey} onChange={(e) => { setForm({ ...form, dateKey: e.target.value }); setStartAt(null); }} aria-label="Date" />
          </section>

          {/* 3. Slot */}
          <section className="cara-card space-y-2 p-4">
            <div className="cara-eyebrow">Time</div>
            {startAt && (
              <div className="text-[13px]">
                Selected: <span className="font-medium">{fmtDay(keyOf(startAt))}, {fmtTime(startAt)}</span>
                {type ? <span className="text-cara-muted"> · {type.durationMin} min</span> : null}
              </div>
            )}
            {!form.dateKey ? (
              <p className="cara-note text-[12px]">Pick a date to see free times.</p>
            ) : type?.needsDoctor && !form.doctorId ? (
              <p className="cara-note text-[12px]">Choose the doctor to see their free times.</p>
            ) : slots === null ? (
              <p className="cara-note text-[12px]">Loading…</p>
            ) : slots.length === 0 ? (
              <p className="cara-note text-[12px]">No free time that day. Try Find a slot for the next available day.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <button
                    key={s.startAt}
                    className={`tag ${startAt === s.startAt ? "tag-klein" : s.needsAck ? "tag-citric" : "tag-aqua"}`}
                    title={s.warnings.join("\n") || "Everything free"}
                    onClick={() => setStartAt(s.startAt)}
                  >
                    {s.needsAck && <IconAlert className="tag-icon" />}
                    {fmtTime(s.startAt)}
                  </button>
                ))}
              </div>
            )}
          </section>

          <textarea className="cara-textarea" rows={2} placeholder="Notes (optional) — e.g. Booked by Akshay, consult with Dr Asif only" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />

          {result && !result.ok && (
            <div className={`cara-notice ${result.justTaken ? "is-warn" : result.needsAck ? "is-warn" : "is-bad"} space-y-1`}>
              <div className="font-medium">{result.error}</div>
              {blocks.length > 1 && (
                <ul className="list-disc pl-5 text-[12.5px]">
                  {blocks.map((b, i) => <li key={i}>{b.message}</li>)}
                </ul>
              )}
              {result.needsAck && (
                <>
                  <ul className="list-disc pl-5 text-[12.5px]">
                    {warnings.map((w, i) => <li key={i}>{w.message}</li>)}
                  </ul>
                  <button className="cara-btn cara-btn-primary mt-1" disabled={pending} onClick={() => book({ ack: true })}>
                    Confirm and book anyway
                  </button>
                </>
              )}
              {result.overridable && viewer.canOverride && (
                <div className="mt-2 space-y-1.5">
                  <input className="cara-input" placeholder="Reason for overriding the room clash *" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                  <button className="cara-btn cara-btn-danger" disabled={pending || !overrideReason.trim()} onClick={() => book({ ack: true, override: true })}>
                    Override and book (logged)
                  </button>
                </div>
              )}
              {result.overridable && !viewer.canOverride && (
                <p className="text-[12px]">A branch manager can override a consultation-room clash.</p>
              )}
            </div>
          )}
          {result?.ok && <div className="cara-notice is-good">{result.info ?? "Done"}</div>}

          <button className="cara-btn cara-btn-primary w-full" disabled={pending || !patient || !startAt} onClick={() => book()}>
            {pending ? "Booking…" : startAt && type ? `Book ${fmtRange(startAt, new Date(new Date(startAt).getTime() + type.durationMin * 60_000).toISOString())}` : "Book"}
          </button>
        </div>
      </div>
    </div>
  );
}
