"use client";

// Find a slot (§2.1 worked example). Pick branch, treatment, the doctor the patient
// asked for, and a day: the screen shows the times that work — or why that day
// doesn't, and the next day that does.
import { useState, useTransition } from "react";
import { searchSlots, type SlotSearchResult } from "@/app/(dashboard)/appointments/actions";
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

function DayResult({ day, heading }: { day: DayAvailability; heading: string }) {
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
        <div className="flex flex-wrap gap-2">
          {day.slots.map((s) => (
            <span
              key={s.startAt}
              className={`tag ${s.needsAck ? "tag-citric" : "tag-aqua"}`}
              title={s.warnings.length ? s.warnings.join("\n") : "Everything free"}
            >
              {s.needsAck && <IconAlert className="tag-icon" />}
              {timeFmt.format(new Date(s.startAt))} – {timeFmt.format(new Date(s.endAt))}
            </span>
          ))}
        </div>
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
}: {
  branches: { id: string; name: string }[];
  types: TypeOpt[];
  doctors: { id: string; name: string }[];
  today: string;
}) {
  const [form, setForm] = useState({ branchId: branches[0]?.id ?? "", typeId: types[0]?.id ?? "", doctorId: "", dateKey: today });
  const [result, setResult] = useState<SlotSearchResult | null>(null);
  const [pending, startTransition] = useTransition();
  const type = types.find((t) => t.id === form.typeId);

  function search() {
    startTransition(async () => setResult(await searchSlots(form)));
  }

  return (
    <div className="space-y-4">
      <div className="cara-card space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <select className="cara-select w-auto!" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} aria-label="Branch">
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
          <input type="date" className="cara-input w-auto!" value={form.dateKey} min={today} onChange={(e) => setForm({ ...form, dateKey: e.target.value })} aria-label="Date" />
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
          <DayResult day={result.requested} heading="Requested day" />
          {result.requested.slots.length === 0 &&
            (result.next ? (
              <DayResult day={result.next} heading="Next available" />
            ) : (
              <p className="cara-note">Nothing free in the next 14 days.</p>
            ))}
        </div>
      )}
    </div>
  );
}
