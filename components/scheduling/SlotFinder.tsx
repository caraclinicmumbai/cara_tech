"use client";

// Find a slot (§2.1 / §2.2 worked examples). Pick branch, treatment, the doctor the
// patient asked for, and a day: the screen shows the times that work — or why that day
// doesn't, and the next day that does. "All branches" asks the chain: the earliest
// slot for that doctor at every branch, soonest first (the call-centre question).
// Clicking a time opens the booking drawer, when the viewer may book there.
import { useState, useTransition } from "react";
import { searchChain, searchSlots, type SlotSearchResult } from "@/app/(dashboard)/appointments/actions";
import type { BranchEarliest } from "@/lib/scheduling/booking";
import type { DayAvailability } from "@/lib/scheduling/booking";
import { IconAlert } from "@/components/Icon";

type TypeOpt = { id: string; label: string; durationMin: number; bufferAfterMin: number; needsDoctor: boolean };

const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" });

function dayLabel(dateKey: string): string {
  return dayFmt.format(new Date(`${dateKey}T12:00:00+05:30`));
}

function hours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

export type SlotPick = { branchId: string; typeId: string; doctorId: string; startAt: string; dateKey: string };

function Chips({
  slots,
  onPick,
}: {
  slots: DayAvailability["slots"];
  onPick?: (startAt: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {slots.map((s) => {
        const cls = `tag ${s.needsAck ? "tag-citric" : "tag-aqua"}`;
        const body = (
          <>
            {s.needsAck && <IconAlert className="tag-icon" />}
            {timeFmt.format(new Date(s.startAt))} – {timeFmt.format(new Date(s.endAt))}
          </>
        );
        return onPick ? (
          <button key={s.startAt} className={cls} title={s.warnings.length ? s.warnings.join("\n") : "Everything free — click to book"} onClick={() => onPick(s.startAt)}>
            {body}
          </button>
        ) : (
          <span key={s.startAt} className={cls} title={s.warnings.length ? s.warnings.join("\n") : "Everything free"}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

function DayResult({ day, heading, onPick }: { day: DayAvailability; heading: string; onPick?: (startAt: string) => void }) {
  return (
    <div className="cara-card space-y-3 p-5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-cara-ink">{heading}</span>
        <span className="text-[12px] text-cara-muted">{dayLabel(day.dateKey)}</span>
        {day.slots.length > 0 && <span className="text-[12px] text-cara-faint">· {day.slots.length} start times</span>}
      </div>
      {day.slots.length === 0 ? (
        <div className="cara-notice is-bad space-y-1">
          <div className="font-medium">Not available</div>
          <ul className="list-disc pl-5">
            {day.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <Chips slots={day.slots} onPick={onPick} />
      )}
      {day.slots.some((s) => s.needsAck) && (
        <p className="cara-note text-[12px]">
          Orange times work, but the doctor or a machine is already busy — booking them needs a confirmation. Hover for
          details.
        </p>
      )}
    </div>
  );
}

export function SlotFinder({
  branches,
  types,
  doctors,
  today,
  initial,
  canPick,
  onPick,
}: {
  branches: { id: string; name: string }[];
  types: TypeOpt[];
  doctors: { id: string; name: string }[];
  today: string;
  initial?: { branchId?: string; doctorId?: string; typeId?: string; dateKey?: string };
  /// May the viewer book at this branch? (2.2.c) — times there become clickable.
  canPick?: (branchId: string) => boolean;
  onPick?: (p: SlotPick) => void;
}) {
  const [form, setForm] = useState({
    branchId: initial?.branchId ?? branches[0]?.id ?? "",
    typeId: initial?.typeId || types[0]?.id || "",
    doctorId: initial?.doctorId ?? "",
    dateKey: initial?.dateKey && initial.dateKey >= today ? initial.dateKey : today,
  });
  const [result, setResult] = useState<SlotSearchResult | null>(null);
  const [chain, setChain] = useState<{ ok: true; branches: BranchEarliest[] } | { ok: false; error: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const type = types.find((t) => t.id === form.typeId);

  function search() {
    startTransition(async () => {
      if (form.branchId === "all") {
        setResult(null);
        setChain(await searchChain({ typeId: form.typeId, doctorId: form.doctorId, dateKey: form.dateKey }));
      } else {
        setChain(null);
        setResult(await searchSlots(form));
      }
    });
  }

  const picker = (branchId: string) =>
    onPick && (!canPick || canPick(branchId))
      ? (startAt: string) =>
          onPick({
            branchId,
            typeId: form.typeId,
            doctorId: form.doctorId,
            startAt,
            dateKey: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(startAt)),
          })
      : undefined;

  return (
    <div className="space-y-4">
      <div className="cara-card space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <select className="cara-select w-auto!" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} aria-label="Branch">
            {branches.length > 1 && <option value="all">All branches — earliest anywhere</option>}
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select className="cara-select w-auto! max-w-[24rem]!" value={form.typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })} aria-label="Treatment">
            {types.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
          {type?.needsDoctor && (
            <select className="cara-select w-auto!" value={form.doctorId} onChange={(e) => setForm({ ...form, doctorId: e.target.value })} aria-label="Doctor">
              <option value="">Choose the doctor *</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
          <input type="date" className="cara-input w-auto!" value={form.dateKey} min={today} onChange={(e) => setForm({ ...form, dateKey: e.target.value })} aria-label="Search from date" />
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={search}>
            {pending ? "Searching…" : "Find slots"}
          </button>
        </div>
        {type && (
          <p className="cara-note text-[12px]">
            {hours(type.durationMin)}
            {type.bufferAfterMin ? ` + ${type.bufferAfterMin} min turnover (rooms and team stay held)` : ""}
          </p>
        )}
      </div>

      {result && !result.ok && <div className="cara-notice is-warn">{result.error}</div>}
      {result?.ok && (
        <div className="space-y-3">
          <DayResult day={result.requested} heading="Requested day" onPick={picker(form.branchId)} />
          {result.requested.slots.length === 0 &&
            (result.next ? (
              <DayResult day={result.next} heading="Next available" onPick={picker(form.branchId)} />
            ) : (
              <p className="cara-note">Nothing free in the next 14 days.</p>
            ))}
        </div>
      )}
      {chain && !chain.ok && <div className="cara-notice is-warn">{chain.error}</div>}
      {chain?.ok && (
        <div className="space-y-3">
          {chain.branches.length === 0 && <p className="cara-note">Nothing free at any branch in the next 14 days.</p>}
          {chain.branches.map((b, i) => (
            <div key={b.branchId} className="cara-card space-y-2 p-5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-cara-ink">{b.branchName}</span>
                <span className="text-[12px] text-cara-muted">{dayLabel(b.dateKey)}</span>
                {i === 0 && <span className="tag tag-lime">earliest</span>}
                {canPick && !canPick(b.branchId) && <span className="text-[11.5px] text-cara-faint">· another branch — the call centre books here</span>}
              </div>
              <Chips slots={b.slots} onPick={picker(b.branchId)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
