"use client";

// The call log's search box and filters (§calls). Everything here only changes the URL:
// the server filters and sends back the page, so the whole history is searched rather
// than the rows already on screen (lib/callList.ts).
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { callListFiltered, callListQuery, type CallListFilters } from "@/lib/callList";
import { IconSearch } from "@/components/Icon";

export type FilterOption = { value: string; label: string };

/// How long typing pauses before the search reloads the list.
const TYPING_DEBOUNCE_MS = 400;

/// "YYYY-MM-DD" today in IST, `offset` days away.
function istDay(offset = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offset * 86_400_000));
}

function MultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <details className="relative">
      <summary className={`cara-select w-auto! cursor-pointer list-none ${selected.length ? "font-medium" : ""}`}>
        {label}
        {selected.length ? ` (${selected.length})` : ""} ▾
      </summary>
      <div className="absolute z-30 mt-1 max-h-64 w-60 space-y-0.5 overflow-auto rounded border border-black/15 bg-background p-2 shadow-lg dark:border-white/20">
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
          >
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => onToggle(o.value)} />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

export function CallFilters({
  filters,
  kinds,
  statuses,
  reps,
}: {
  filters: CallListFilters;
  kinds: FilterOption[];
  statuses: FilterOption[];
  reps: FilterOption[];
}) {
  const router = useRouter();
  const [loading, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.q);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /// Load the list for `next`. Any change of filter goes back to page 1.
  function go(next: Partial<CallListFilters>) {
    // A reload still waiting on the keyboard was built from older filters — this one wins.
    if (typingTimer.current) clearTimeout(typingTimer.current);
    const qs = callListQuery({ ...filters, q: search, page: 1, ...next });
    startTransition(() => router.replace(qs ? `/calls?${qs}` : "/calls", { scroll: false }));
  }
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const dayRange = (fromDay: string, toDay: string) => go({ from: `${fromDay}T00:00`, to: `${toDay}T23:59` });

  return (
    <div className={`flex flex-wrap items-end gap-2 transition-opacity ${loading ? "opacity-60" : ""}`}>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-cara-muted">
          <IconSearch size={13} />
        </span>
        <input
          value={search}
          onChange={(e) => {
            const q = e.target.value;
            setSearch(q);
            if (typingTimer.current) clearTimeout(typingTimer.current);
            typingTimer.current = setTimeout(() => go({ q }), TYPING_DEBOUNCE_MS);
          }}
          placeholder="Search by patient name or phone…"
          aria-label="Search calls by patient name or phone"
          className="w-72 rounded-lg border-2 border-cara-rule bg-cara-surface-2 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-cara-faint focus:border-cara-beige-deep focus:bg-cara-page"
        />
      </div>
      <MultiSelect label="Type" options={kinds} selected={filters.kinds} onToggle={(v) => go({ kinds: toggle(filters.kinds, v) })} />
      <MultiSelect label="Status" options={statuses} selected={filters.statuses} onToggle={(v) => go({ statuses: toggle(filters.statuses, v) })} />
      <MultiSelect label="Team member" options={reps} selected={filters.reps} onToggle={(v) => go({ reps: toggle(filters.reps, v) })} />
      <label className="space-y-0.5 text-[11px] text-cara-muted">
        <span className="block">From</span>
        <input type="datetime-local" className="cara-input w-auto!" value={filters.from} onChange={(e) => go({ from: e.target.value })} />
      </label>
      <label className="space-y-0.5 text-[11px] text-cara-muted">
        <span className="block">To</span>
        <input type="datetime-local" className="cara-input w-auto!" value={filters.to} onChange={(e) => go({ to: e.target.value })} />
      </label>
      <div className="flex items-center gap-2 pb-2 text-xs">
        <button type="button" className="tone-link hover:underline" onClick={() => dayRange(istDay(), istDay())}>Today</button>
        <button type="button" className="tone-link hover:underline" onClick={() => dayRange(istDay(-1), istDay(-1))}>Yesterday</button>
        <button type="button" className="tone-link hover:underline" onClick={() => dayRange(istDay(-6), istDay())}>Last 7 days</button>
        {callListFiltered({ ...filters, q: search }) && (
          <button
            type="button"
            className="tone-link hover:underline"
            onClick={() => {
              setSearch("");
              go({ q: "", kinds: [], statuses: [], reps: [], from: "", to: "" });
            }}
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
