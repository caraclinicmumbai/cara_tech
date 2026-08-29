"use client";

// The date range every report on the page answers about (§reports). Presets are plain
// links; the two date inputs submit as a GET form. Both paths write the range into the
// URL rather than into component state, so a range is shareable, bookmarkable, and
// survives switching between report tabs.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { RANGE_PRESETS } from "@/lib/reports/range";

export function ReportRangePicker({
  fromDay,
  toDay,
  preset,
  today,
}: {
  fromDay: string;
  toDay: string;
  /// Null when the dates were typed by hand — no preset pill is lit.
  preset: string | null;
  /// Today in IST, computed on the server: `new Date()` in the browser would be the
  /// viewer's timezone, which is not necessarily the clinic's.
  today: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const report = params.get("r");

  const presetHref = (key: string) => {
    const next = new URLSearchParams();
    if (report) next.set("r", report);
    next.set("preset", key);
    return `${pathname}?${next.toString()}`;
  };

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
      <div className="flex flex-wrap gap-1.5">
        {RANGE_PRESETS.map((p) => (
          <Link key={p.key} href={presetHref(p.key)} className={`cara-pill${preset === p.key ? " on" : ""}`}>
            {p.label}
          </Link>
        ))}
      </div>

      <form method="GET" action={pathname} className="flex flex-wrap items-end gap-2">
        {report && <input type="hidden" name="r" value={report} />}
        <label className="flex flex-col gap-1">
          <span className="cara-label">From</span>
          <input type="date" name="from" defaultValue={fromDay} max={today} className="cara-input py-1 text-[13px]" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="cara-label">To</span>
          <input type="date" name="to" defaultValue={toDay} max={today} className="cara-input py-1 text-[13px]" />
        </label>
        <button type="submit" className="cara-btn py-1.5 text-[13px]">
          Apply
        </button>
      </form>
    </div>
  );
}
