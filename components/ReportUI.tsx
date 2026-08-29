// Presentational primitives shared by every report (§reports). Server components, no
// client JS — a report is a read-out, and the whole page is a link away from being
// re-rendered with a different range.
//
// The one rule they all obey: **null is not zero.** Every value here renders `null` as
// an em dash, because a report that prints 0% for "we have nothing to divide by" is
// worse than one that admits it doesn't know.

import Link from "next/link";
import type { ReactNode } from "react";

export function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "good" | "warning" | "danger";
}) {
  const toneCls =
    tone === "good"
      ? "text-[var(--state-success-tx)]"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-cara-ink";
  return (
    <div className="cara-card px-4 py-3">
      <div className="cara-eyebrow">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="cara-note mt-0.5 text-[11px] leading-snug">{hint}</div>}
    </div>
  );
}

export function Panel({
  title,
  hint,
  children,
  wide,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`cara-card space-y-3 p-5${wide ? " lg:col-span-2" : ""}`}>
      <div>
        <h2 className="cara-eyebrow">{title}</h2>
        {hint && <p className="cara-note mt-1 text-[11px] leading-snug">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/// The grey "how to read this" line under a report heading. Reports carry their own
/// caveats: the numbers are only useful if you know what they counted.
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="cara-note max-w-3xl text-[12px] leading-relaxed text-cara-faint">{children}</p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-cara-faint">{children}</p>;
}

export function Bars({
  items,
  emptyText = "Nothing in this range.",
}: {
  items: { label: string; value: number; display?: string; sub?: string }[];
  emptyText?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <div className="space-y-2">
      {items.map((i) => (
        <div key={i.label} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-cara-ink">{i.label}</span>
            <span className="shrink-0 tabular-nums text-cara-muted">
              {i.display ?? i.value.toLocaleString("en-IN")}
              {i.sub && <span className="ml-1.5 text-[11px] text-cara-faint">{i.sub}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-cara-surface-2">
            <div
              className="h-full rounded-full bg-cara-beige"
              style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/// A day-by-day column chart. Every day in the range gets a column, including the empty
/// ones — a gap is usually the most interesting thing on the chart (a form that broke,
/// a campaign that stopped, a weekend).
export function DayChart({
  points,
  label,
}: {
  points: { day: string; value: number; second?: number }[];
  label: string;
}) {
  const max = Math.max(1, ...points.map((p) => Math.max(p.value, p.second ?? 0)));
  if (points.length === 0) return <Empty>No days in range.</Empty>;
  // Past ~90 days the columns are thinner than a hairline; the table below still holds
  // the detail, so the chart just gets denser rather than lying about resolution.
  return (
    <div>
      <div className="flex h-28 items-end gap-[2px]" aria-label={label}>
        {points.map((p) => (
          <div
            key={p.day}
            className="group relative flex-1"
            title={`${p.day}: ${p.value}${p.second != null ? ` (${p.second} reached)` : ""}`}
          >
            <div className="flex h-28 flex-col justify-end">
              <div
                className="w-full rounded-t-[2px] bg-cara-beige"
                style={{ height: `${(p.value / max) * 100}%` }}
              />
              {p.second != null && (
                <div
                  className="w-full rounded-b-[2px] bg-[var(--state-success-tx)] opacity-70"
                  style={{ height: `${(p.second / max) * 100}%` }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-cara-faint">
        <span>{points[0]?.day}</span>
        <span className="tabular-nums">peak {max}</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </div>
  );
}

export function Table({
  head,
  children,
  note,
}: {
  head: (string | { label: string; align?: "right" })[];
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="cara-card overflow-x-auto">
        <table className="cara-table">
          <thead>
            <tr>
              {head.map((h, i) => {
                const label = typeof h === "string" ? h : h.label;
                const align = typeof h === "string" ? undefined : h.align;
                return (
                  <th key={`${label}-${i}`} className={align === "right" ? "text-right" : undefined}>
                    {label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {note && <p className="cara-note text-[11px] text-cara-faint">{note}</p>}
    </div>
  );
}

/// A right-aligned numeric cell. `unavailable` renders the reason instead of a number —
/// used wherever ad spend hasn't been imported, so a hole never reads as a zero.
export function Num({
  children,
  strong,
  unavailable,
}: {
  children: ReactNode;
  strong?: boolean;
  unavailable?: string;
}) {
  if (unavailable) {
    return (
      <td className="text-right">
        <span className="text-[11px] italic text-cara-faint" title={unavailable}>
          unavailable
        </span>
      </td>
    );
  }
  return (
    <td className={`text-right tabular-nums${strong ? " font-semibold text-cara-ink" : ""}`}>
      {children}
    </td>
  );
}

export function LeadLink({ id, name }: { id: string; name: string }) {
  return (
    <Link href={`/leads/${id}`} className="font-medium text-cara-ink hover:underline">
      {name}
    </Link>
  );
}
