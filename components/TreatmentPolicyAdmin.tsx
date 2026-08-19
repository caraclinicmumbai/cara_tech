"use client";

// Editor for the per-treatment stage time limits (§post-sales). One card per treatment
// type; each stage takes a whole number of days, or blank for "no limit".
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { JOURNEY_STAGES, JOURNEY_STAGE_LABELS, TERMINAL_JOURNEY_STAGE } from "@/lib/postSales/stages";
import { saveTreatmentPolicy } from "@/app/(dashboard)/post-sales/actions";

export type PolicyRow = {
  treatmentType: string;
  label: string;
  stageDays: Record<string, number>;
  checkInDays: number[];
  active: boolean;
  isDefault: boolean;
  /// false = these are the built-in numbers; nothing has been saved for this treatment.
  configured: boolean;
};

// The terminal stage is never timed — a closed journey can't go overdue — so it isn't
// offered as an editable field.
const EDITABLE_STAGES = JOURNEY_STAGES.filter((s) => s !== TERMINAL_JOURNEY_STAGE);

function PolicyCard({ row }: { row: PolicyRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [label, setLabel] = useState(row.label);
  const [days, setDays] = useState<Record<string, string>>(() =>
    Object.fromEntries(EDITABLE_STAGES.map((s) => [s, row.stageDays[s] != null ? String(row.stageDays[s]) : ""])),
  );
  const [checkIns, setCheckIns] = useState(row.checkInDays.join(", "));
  const [active, setActive] = useState(row.active);
  const [isDefault, setIsDefault] = useState(row.isDefault);

  function submit() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await saveTreatmentPolicy({
        treatmentType: row.treatmentType,
        label,
        stageDays: days,
        checkInDays: checkIns,
        active,
        isDefault,
      });
      if (!res.ok) setError(res.error ?? "Could not save");
      else {
        setSaved(true);
        router.refresh();
      }
    });
  }

  return (
    <section className="cara-card space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="cara-sec-hd">{row.label}</h2>
          <code className="text-[11px] text-cara-faint">{row.treatmentType}</code>
        </div>
        <div className="flex items-center gap-1">
          {row.isDefault && <span className="cara-badge cara-badge-info">fallback</span>}
          {!row.configured && <span className="cara-badge">built-in defaults</span>}
          {!row.active && <span className="cara-badge cara-badge-warning">inactive</span>}
        </div>
      </div>

      {error && <div className="cara-callout cara-callout-danger">{error}</div>}
      {saved && !error && <div className="cara-callout cara-callout-success">Saved.</div>}

      <label className="block space-y-1">
        <span className="cara-label">Display name</span>
        <input className="cara-input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {EDITABLE_STAGES.map((s) => (
          <label key={s} className="space-y-1">
            <span className="cara-label">{JOURNEY_STAGE_LABELS[s]}</span>
            <input
              className="cara-input"
              type="number"
              min={1}
              step={1}
              placeholder="no limit"
              value={days[s] ?? ""}
              onChange={(e) => setDays((d) => ({ ...d, [s]: e.target.value }))}
            />
            <span className="block text-[11px] text-cara-faint">days</span>
          </label>
        ))}
      </div>

      <label className="block space-y-1">
        <span className="cara-label">Check-in days after surgery</span>
        <input
          className="cara-input"
          value={checkIns}
          onChange={(e) => setCheckIns(e.target.value)}
          placeholder="1, 7, 30, 90"
        />
        <span className="block text-[11px] text-cara-faint">
          Comma-separated. Applies to journeys whose schedule is generated after you save.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
          Use as the fallback for treatments with no policy
        </label>
        <button type="button" className="cara-btn cara-btn-save" disabled={pending} onClick={submit}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

export function TreatmentPolicyAdmin({ rows }: { rows: PolicyRow[] }) {
  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <PolicyCard key={r.treatmentType} row={r} />
      ))}
    </div>
  );
}
