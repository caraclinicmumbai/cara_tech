"use client";

import Link from "next/link";
import { saveLeadQueue } from "@/lib/leadQueue";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { StageSelect } from "@/components/StageSelect";
import { TagField } from "@/components/TagField";
import { LeadDeleteButton } from "@/components/LeadDeleteButton";
import { RemarkField } from "@/components/RemarkField";

export type LeadRow = {
  id: string;
  name: string;
  phone: string;
  source: string | null;
  campaign: string | null;
  adId: string | null;
  stage: string;
  tag: string | null;
  interest: string | null;
  status: string;
  created: string;
  updated: string;
  /// The same two moments as IST calendar days ("YYYY-MM-DD"), for their date filters.
  createdDate: string;
  updatedDate: string;
  /// Name of the sales rep who owns the lead (null = unassigned).
  assignedRep: string | null;
  /// Earliest pending follow-up step: pre-formatted time + its title (tooltip).
  /// `nextFollowUpOverdue` is derived server-side (dueAt in the past).
  nextFollowUp: string | null;
  /// The same due date as "YYYY-MM-DD" (IST) — what the date filter compares against.
  nextFollowUpDate: string | null;
  nextFollowUpTitle: string | null;
  nextFollowUpOverdue: boolean;
  /// Rupee value of the lead's won quotes, or the latest open quote if none won.
  dealAmount: number | null;
  dealWon: boolean;
  lastCall: string | null;
  remark: string | null;
  calls: number;
  cqs: number | null;
  duplicateOfId: string | null;
  optedOut: boolean;
  heldForReview: boolean;
  needsHandover: boolean;
  handoverReason: string | null;
};

type FilterKind = "none" | "enum" | "text" | "date";

/// The one-tap options offered above a date picker. Which ones a column shows
/// depends on which way it points in time: a follow-up is a future commitment you
/// can fall behind on, while Created and Updated are history.
type DateShortcut = "today" | "tomorrow" | "yesterday" | "overdue";

type Col = {
  key: string;
  label: string;
  /// Underlying value used for filtering/sorting ("" = empty, shown as "—").
  value: (l: LeadRow) => string;
  /// What the CELL renders. Every column defines its own, so the header row and the
  /// body row are generated from ONE list and cannot drift apart.
  ///
  /// They used to be two lists — headers mapped from this array, cells hand-written in
  /// a fixed order — and reordering a column silently shifted every cell to its right
  /// under the wrong heading. A table that quietly puts a phone number under "Created"
  /// is worse than one that's ugly, so the two are now the same list by construction.
  cell: (l: LeadRow, ctx: CellContext) => ReactNode;
  /// For a "date" column: the row's date as YYYY-MM-DD, or "" when it has none.
  dateValue?: (l: LeadRow) => string;
  /// For a "date" column offering the Overdue shortcut: is this row past due?
  dateOverdue?: (l: LeadRow) => boolean;
  dateShortcuts?: DateShortcut[];
  /// Friendly label for a raw value in an enum filter dropdown.
  display?: (v: string) => string;
  filter: FilterKind;
  number?: boolean;
  /// Cell layout. `wrap` opts out of the default whitespace-nowrap.
  align?: "right";
  wrap?: boolean;
};

/// What a cell renderer may need beyond the row itself.
type CellContext = {
  sourceLabels: Record<string, string>;
  canRemark: boolean;
  onOpenLead: () => void;
};

const MUTED = "text-black/60 dark:text-white/60";

/// The small status pills on a lead's name — duplicate, opted out, held, handover.
const BADGE_TONES = {
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  red: "bg-red-500/15 text-red-700 dark:text-red-400",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
} as const;

function Badge({
  tone,
  title,
  children,
}: {
  tone: keyof typeof BADGE_TONES;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className={`ml-2 rounded-full px-2 py-0.5 text-xs ${BADGE_TONES[tone]}`}>
      {children}
    </span>
  );
}

type OpenFilter = { key: string; x: number; y: number };

/// A day relative to today as the IST calendar day, in the "YYYY-MM-DD" a date input
/// speaks. Matches how the server stamps the row dates, so the shortcuts and the
/// picker compare like for like wherever the browser's own clock is set.
function istDayKey(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const SHORTCUT_DAY: Record<Exclude<DateShortcut, "overdue">, () => string> = {
  today: () => istDayKey(0),
  tomorrow: () => istDayKey(1),
  yesterday: () => istDayKey(-1),
};
const SHORTCUT_LABEL: Record<DateShortcut, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  yesterday: "Yesterday",
  overdue: "Overdue",
};

export function LeadsTable({
  leads,
  sourceLabels,
  stageLabels,
  canDelete = false,
  canRemark = false,
}: {
  leads: LeadRow[];
  sourceLabels: Record<string, string>;
  stageLabels: Record<string, string>;
  canDelete?: boolean;
  canRemark?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [enumFilters, setEnumFilters] = useState<Record<string, Set<string>>>({});
  const [textFilters, setTextFilters] = useState<Record<string, string>>({});
  /// Date columns filter either to one calendar day ("2026-08-29") or to everything
  /// already past due — the two questions a desk actually asks of a follow-up date.
  const [dateFilters, setDateFilters] = useState<Record<string, { day?: string; overdue?: boolean }>>({});
  const [openFilter, setOpenFilter] = useState<OpenFilter | null>(null);

  const columns: Col[] = useMemo(
    () => [
      {
        key: "name",
        label: "Name",
        value: (l) => l.name,
        filter: "none",
        cell: (l, ctx) => (
          <>
            <Link href={`/leads/${l.id}`} className="font-medium hover:underline" onClick={ctx.onOpenLead}>
              {l.name}
            </Link>
            {l.duplicateOfId && <Badge tone="amber" title="Possible duplicate — no AI call">dup</Badge>}
            {l.optedOut && <Badge tone="red" title="Opted out — all outreach suppressed">opted out</Badge>}
            {l.heldForReview && <Badge tone="orange" title="Held for review — no AI call">review</Badge>}
            {l.needsHandover && (
              <Badge tone="purple" title={l.handoverReason ?? "Handover to sales"}>handover</Badge>
            )}
          </>
        ),
      },
      // Created sits second, right after the name, because the first question the desk
      // asks a lead list every morning is "which of these came in today?" — it used to
      // be sixteen columns to the right, past the edge of the screen.
      {
        key: "created",
        label: "Created",
        value: (l) => l.created,
        dateValue: (l) => l.createdDate,
        dateShortcuts: ["today", "yesterday"],
        filter: "date",
        cell: (l) => <span className={MUTED}>{l.created}</span>,
      },
      { key: "phone", label: "Phone", value: (l) => l.phone, filter: "text", cell: (l) => l.phone },
      {
        key: "source",
        label: "Source",
        value: (l) => l.source ?? "",
        display: (v) => (v ? (sourceLabels[v] ?? v) : "Other"),
        filter: "enum",
        cell: (l, ctx) => (
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
            {l.source ? (ctx.sourceLabels[l.source] ?? l.source) : "—"}
          </span>
        ),
      },
      {
        key: "campaign",
        label: "Campaign",
        value: (l) => l.campaign ?? "",
        filter: "text",
        cell: (l) =>
          l.campaign ? <span title={l.adId ? `Ad: ${l.adId}` : undefined}>{l.campaign}</span> : "—",
      },
      {
        key: "stage",
        label: "Stage",
        value: (l) => l.stage,
        display: (v) => stageLabels[v] ?? v,
        filter: "enum",
        cell: (l) => <StageSelect leadId={l.id} stage={l.stage} />,
      },
      {
        key: "tag",
        label: "Tag",
        value: (l) => l.tag ?? "",
        filter: "text",
        cell: (l) => <TagField leadId={l.id} tag={l.tag} />,
      },
      {
        key: "interest",
        label: "Treatment",
        value: (l) => l.interest ?? "",
        filter: "text",
        wrap: true,
        cell: (l) => (
          <span className="block max-w-50 truncate" title={l.interest ?? undefined}>
            {l.interest ?? "—"}
          </span>
        ),
      },
      { key: "status", label: "Status", value: (l) => l.status, filter: "enum", cell: (l) => l.status },
      {
        key: "assignedRep",
        label: "Owner",
        value: (l) => l.assignedRep ?? "",
        display: (v) => v || "Unassigned",
        filter: "enum",
        cell: (l) =>
          l.assignedRep ?? <span className="text-black/40 dark:text-white/40">Unassigned</span>,
      },
      {
        key: "nextFollowUp",
        label: "Next follow-up",
        value: (l) => l.nextFollowUp ?? "",
        dateValue: (l) => l.nextFollowUpDate ?? "",
        dateOverdue: (l) => l.nextFollowUpOverdue,
        dateShortcuts: ["today", "tomorrow", "overdue"],
        filter: "date",
        cell: (l) =>
          l.nextFollowUp ? (
            <span
              title={l.nextFollowUpTitle ?? undefined}
              className={
                l.nextFollowUpOverdue
                  ? "rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-700 dark:text-red-400"
                  : MUTED
              }
            >
              {l.nextFollowUp}
            </span>
          ) : (
            "—"
          ),
      },
      {
        key: "dealAmount",
        label: "Deal amount",
        value: (l) => (l.dealAmount == null ? "" : String(l.dealAmount)),
        filter: "none",
        align: "right",
        cell: (l) =>
          l.dealAmount == null ? (
            "—"
          ) : (
            <span
              title={l.dealWon ? "Total of won quotes" : "Latest open quote — not converted yet"}
              className={l.dealWon ? "font-medium" : MUTED}
            >
              ₹{l.dealAmount.toLocaleString("en-IN")}
            </span>
          ),
      },
      {
        key: "calls",
        label: "Calls",
        value: (l) => String(l.calls),
        filter: "enum",
        number: true,
        cell: (l) => l.calls,
      },
      {
        key: "lastCall",
        label: "Last call",
        value: (l) => l.lastCall ?? "",
        filter: "none",
        cell: (l) => <span className={MUTED}>{l.lastCall ?? "—"}</span>,
      },
      {
        key: "cqs",
        label: "CQS",
        value: (l) => (l.cqs == null ? "" : String(l.cqs)),
        display: (v) => (v === "" ? "—" : v),
        filter: "enum",
        number: true,
        cell: (l) =>
          typeof l.cqs === "number" ? (
            <span
              title="Conversation Quality Score (latest scored call)"
              className={`rounded-full px-2 py-0.5 text-xs ${
                l.cqs >= 75
                  ? "bg-green-600/15 text-green-700 dark:text-green-400"
                  : l.cqs >= 50
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    : "bg-red-500/15 text-red-700 dark:text-red-400"
              }`}
            >
              {l.cqs}
            </span>
          ) : (
            "—"
          ),
      },
      {
        key: "remark",
        label: "Remark",
        value: (l) => l.remark ?? "",
        filter: "text",
        wrap: true,
        cell: (l, ctx) =>
          ctx.canRemark ? (
            <RemarkField leadId={l.id} remark={l.remark} />
          ) : (
            <span className="block max-w-[18rem] truncate text-xs" title={l.remark ?? undefined}>
              {l.remark ?? "—"}
            </span>
          ),
      },
      // History rather than a commitment, so this offers Today/Yesterday and no
      // Overdue — there's nothing to fall behind on. (Created carries the same filter
      // and now sits second, next to the name.)
      {
        key: "updated",
        label: "Updated",
        value: (l) => l.updated,
        dateValue: (l) => l.updatedDate,
        dateShortcuts: ["today", "yesterday"],
        filter: "date",
        cell: (l) => <span className={MUTED}>{l.updated}</span>,
      },
    ],
    [sourceLabels, stageLabels],
  );

  // Distinct values per enum column, for its dropdown.
  const distinct = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of columns) {
      if (c.filter !== "enum") continue;
      const set = new Set<string>();
      for (const l of leads) set.add(c.value(l));
      m[c.key] = Array.from(set).sort((a, b) =>
        c.number ? Number(a) - Number(b) : a.localeCompare(b),
      );
    }
    return m;
  }, [leads, columns]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (q && !l.name.toLowerCase().includes(q)) return false;
      for (const c of columns) {
        if (c.filter === "enum") {
          const sel = enumFilters[c.key];
          if (sel && sel.size > 0 && !sel.has(c.value(l))) return false;
        } else if (c.filter === "text") {
          const t = textFilters[c.key]?.trim().toLowerCase();
          if (t && !c.value(l).toLowerCase().includes(t)) return false;
        } else if (c.filter === "date") {
          const f = dateFilters[c.key];
          if (f?.day && c.dateValue?.(l) !== f.day) return false;
          // "Overdue" is a property of the row, not of the date string: a step is
          // missed once its due moment has passed, which the server already decided.
          if (f?.overdue && !c.dateOverdue?.(l)) return false;
        }
      }
      return true;
    });
  }, [leads, columns, search, enumFilters, textFilters, dateFilters]);

  function toggleEnum(key: string, v: string) {
    setEnumFilters((prev) => {
      const next = { ...prev };
      const set = new Set(next[key] ?? []);
      if (set.has(v)) set.delete(v);
      else set.add(v);
      if (set.size === 0) delete next[key];
      else next[key] = set;
      return next;
    });
  }
  function setText(key: string, v: string) {
    setTextFilters((prev) => {
      const next = { ...prev };
      if (v) next[key] = v;
      else delete next[key];
      return next;
    });
  }
  function setDate(key: string, patch: { day?: string; overdue?: boolean } | null) {
    setDateFilters((prev) => {
      const next = { ...prev };
      if (!patch || (!patch.day && !patch.overdue)) delete next[key];
      else next[key] = patch;
      return next;
    });
  }
  function clearColumn(key: string) {
    setEnumFilters((prev) => {
      const n = { ...prev };
      delete n[key];
      return n;
    });
    setText(key, "");
    setDate(key, null);
  }

  // Open the filter panel anchored just under the clicked caret. Rendered as a
  // FIXED layer (not inside the scroll container) so it can't be clipped.
  function openFilterAt(key: string, el: HTMLElement) {
    if (openFilter?.key === key) {
      setOpenFilter(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const width = 208; // w-52
    const x = Math.min(r.left, window.innerWidth - width - 8);
    setOpenFilter({ key, x: Math.max(8, x), y: r.bottom + 4 });
  }

  const isFiltered = (key: string) =>
    !!enumFilters[key]?.size || !!textFilters[key] || !!dateFilters[key];
  const anyActive =
    !!search ||
    Object.keys(enumFilters).length > 0 ||
    Object.keys(textFilters).length > 0 ||
    Object.keys(dateFilters).length > 0;

  const openCol = openFilter ? columns.find((c) => c.key === openFilter.key) : null;

  /// What the current filter is, in words — carried into the lead page so the queue
  /// nav can say which list it's stepping through ("Follow-up: today · Owner: Rohit").
  const filterLabel = useMemo(() => {
    const parts: string[] = [];
    if (search.trim()) parts.push(`"${search.trim()}"`);
    for (const c of columns) {
      const sel = enumFilters[c.key];
      if (sel?.size) parts.push(`${c.label}: ${Array.from(sel).slice(0, 2).join(", ")}${sel.size > 2 ? "…" : ""}`);
      const t = textFilters[c.key]?.trim();
      if (t) parts.push(`${c.label}: ${t}`);
      const d = dateFilters[c.key];
      if (d?.day) parts.push(`${c.label}: ${d.day}`);
      if (d?.overdue) parts.push(`${c.label}: overdue`);
    }
    return parts.length ? parts.join(" · ") : "All leads";
  }, [columns, search, enumFilters, textFilters, dateFilters]);

  // ── Sideways scrolling (§leads table) ──────────────────────────────
  // Eighteen columns don't fit on a laptop, and a mouse wheel only scrolls vertically —
  // so the desk gets explicit ‹ › buttons as well as the scrollbar. They sit ABOVE the
  // table rather than floating over it: a long list would otherwise put a
  // vertically-centred arrow somewhere you have to scroll down to reach, and an overlay
  // on the edge covers the very cells you're trying to read.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({ left: false, right: false });

  /// Recompute which directions are still available. Called from the scroll handler and
  /// from the container's callback ref — never from an effect, which React 19 forbids
  /// setting state in.
  ///
  /// The equality bail-out is load-bearing, not an optimisation: the ref callback runs
  /// on every render, so setting a fresh state object each time would re-render, re-run
  /// the ref, and loop until React gave up with "Maximum update depth exceeded".
  const syncScroll = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < max - 1;
    setScrollState((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  /// Stable so the ref isn't detached and reattached on every render.
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      syncScroll(node);
    },
    [syncScroll],
  );

  /// One press moves about four-fifths of a screen, so a column or two stays visible as
  /// an anchor rather than the whole view jumping to unfamiliar content.
  function nudge(direction: -1 | 1) {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(240, el.clientWidth * 0.8), behavior: "smooth" });
  }

  const scrollBtn =
    "rounded-lg border border-cara-rule bg-cara-surface-2 px-2.5 py-1.5 text-sm leading-none text-cara-ink transition-colors hover:bg-cara-page disabled:cursor-not-allowed disabled:opacity-35";

  /// Everything a cell renderer needs beyond its row. Clicking a lead's name captures
  /// the current filtered list so the lead page can step through it (§leads table).
  const cellContext: CellContext = useMemo(
    () => ({
      sourceLabels,
      canRemark,
      onOpenLead: () => saveLeadQueue({ ids: rows.map((r) => r.id), label: filterLabel }),
    }),
    [sourceLabels, canRemark, rows, filterLabel],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* The search box used to be a plain bordered box on a bordered panel and the
            desk couldn't find it. Now it carries a magnifier, a filled ground and a
            wider frame — it should read as the one thing on the row you type into. */}
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base leading-none text-cara-muted"
          >
            🔍
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search leads by name…"
            aria-label="Search leads by name"
            className="w-72 rounded-lg border-2 border-cara-rule bg-cara-surface-2 py-2 pl-9 pr-8 text-sm outline-none transition-colors placeholder:text-cara-faint focus:border-cara-beige-deep focus:bg-cara-page"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-sm text-cara-muted hover:text-cara-ink"
            >
              ×
            </button>
          )}
        </div>
        <span className="text-sm text-black/50 dark:text-white/50">
          {rows.length} of {leads.length}
        </span>
        {anyActive && (
          <button
            onClick={() => {
              setSearch("");
              setEnumFilters({});
              setTextFilters({});
              setDateFilters({});
            }}
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            Clear all filters
          </button>
        )}

        {/* Sideways scroll, right-aligned so it sits over the far edge of the table —
            where the columns you're trying to reach actually are. */}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[11px] text-cara-faint">Scroll columns</span>
          <button
            type="button"
            onClick={() => nudge(-1)}
            disabled={!scrollState.left}
            aria-label="Scroll table left"
            title="Scroll left"
            className={scrollBtn}
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => nudge(1)}
            disabled={!scrollState.right}
            aria-label="Scroll table right"
            title="Scroll right"
            className={scrollBtn}
          >
            ›
          </button>
        </div>
      </div>

      {/* cara-scroll-x forces a visible scrollbar — see app/globals.css. With overlay
          scrollbars and a mouse, eighteen columns read as "the table ends here". */}
      <div
        // A callback ref rather than useEffect: it fires on mount with the element in
        // hand, which is exactly when the arrows need enabling, and it keeps
        // state-setting out of an effect.
        ref={attachScroller}
        onScroll={(e) => syncScroll(e.currentTarget)}
        className="cara-scroll-x rounded border border-black/10 dark:border-white/15"
      >
        <table className="min-w-full text-sm">
          <thead className="bg-black/5 text-left dark:bg-white/10">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  className={`whitespace-nowrap px-4 py-2 ${
                    i === 0
                      ? "sticky left-0 z-20 border-r border-black/10 bg-background dark:border-white/15"
                      : ""
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className="font-semibold">{c.label}</span>
                    {c.filter !== "none" && (
                      <button
                        onClick={(e) => openFilterAt(c.key, e.currentTarget)}
                        title="Filter"
                        className={`rounded px-1 text-xs ${
                          isFiltered(c.key)
                            ? "text-blue-600 dark:text-blue-400"
                            : "text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
                        }`}
                      >
                        ▾
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="whitespace-nowrap px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((lead) => (
              <tr key={lead.id} className="border-t border-black/5 dark:border-white/10">
                {/* Cells come from the same `columns` list as the headers above, so a
                    column can be reordered in one place without data sliding under the
                    wrong heading. */}
                {columns.map((c, i) => (
                  <td
                    key={c.key}
                    className={`px-4 py-2 ${c.wrap ? "" : "whitespace-nowrap"} ${
                      c.align === "right" ? "text-right tabular-nums" : ""
                    } ${
                      i === 0
                        ? "sticky left-0 z-10 border-r border-black/5 bg-background dark:border-white/10"
                        : ""
                    }`}
                  >
                    {c.cell(lead, cellContext)}
                  </td>
                ))}
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {canDelete ? (
                    <LeadDeleteButton leadId={lead.id} name={lead.name} />
                  ) : (
                    <span className="text-black/30 dark:text-white/30">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Filter panel — fixed layer so the table's overflow can't clip it. */}
      {openFilter && openCol && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpenFilter(null)} />
          <div
            style={{ position: "fixed", top: openFilter.y, left: openFilter.x, width: 208 }}
            className="z-50 rounded border border-black/15 bg-background p-2 shadow-lg dark:border-white/20"
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium">Filter {openCol.label}</span>
              <button
                onClick={() => clearColumn(openCol.key)}
                className="text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                Clear
              </button>
            </div>
            {openCol.filter === "date" ? (
              // A calendar: pick the day and the table shows the rows dated then.
              // The shortcuts are per column — a follow-up can be overdue, a
              // created/updated date can only be in the past.
              <div className="space-y-2">
                <input
                  autoFocus
                  type="date"
                  value={dateFilters[openCol.key]?.day ?? ""}
                  onChange={(e) => setDate(openCol.key, { day: e.target.value || undefined })}
                  className="w-full rounded border border-black/15 bg-background px-2 py-1 text-xs outline-none focus:border-black/40 dark:border-white/20"
                />
                <div className="flex flex-wrap gap-1">
                  {(openCol.dateShortcuts ?? ["today"]).map((s) => {
                    const day = s === "overdue" ? null : SHORTCUT_DAY[s]();
                    const active =
                      s === "overdue"
                        ? !!dateFilters[openCol.key]?.overdue
                        : dateFilters[openCol.key]?.day === day;
                    return (
                      <button
                        key={s}
                        onClick={() =>
                          setDate(openCol.key, day ? { day } : { overdue: true })
                        }
                        className={`rounded border px-2 py-0.5 text-xs ${
                          active
                            ? s === "overdue"
                              ? "border-red-500 text-red-600 dark:text-red-400"
                              : "border-blue-500 text-blue-600 dark:text-blue-400"
                            : "border-black/15 dark:border-white/20"
                        }`}
                      >
                        {SHORTCUT_LABEL[s]}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : openCol.filter === "text" ? (
              <input
                autoFocus
                value={textFilters[openCol.key] ?? ""}
                onChange={(e) => setText(openCol.key, e.target.value)}
                placeholder="Contains…"
                className="w-full rounded border border-black/15 bg-background px-2 py-1 text-xs outline-none focus:border-black/40 dark:border-white/20"
              />
            ) : (
              <div className="max-h-56 space-y-0.5 overflow-auto">
                {distinct[openCol.key]?.map((v) => (
                  <label
                    key={v || "∅"}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <input
                      type="checkbox"
                      checked={enumFilters[openCol.key]?.has(v) ?? false}
                      onChange={() => toggleEnum(openCol.key, v)}
                    />
                    <span className="truncate">
                      {openCol.display ? openCol.display(v) : v || "—"}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
