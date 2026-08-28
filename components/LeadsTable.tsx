"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
  /// For a "date" column: the row's date as YYYY-MM-DD, or "" when it has none.
  dateValue?: (l: LeadRow) => string;
  /// For a "date" column offering the Overdue shortcut: is this row past due?
  dateOverdue?: (l: LeadRow) => boolean;
  dateShortcuts?: DateShortcut[];
  /// Friendly label for a raw value in an enum filter dropdown.
  display?: (v: string) => string;
  filter: FilterKind;
  number?: boolean;
};

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
      { key: "name", label: "Name", value: (l) => l.name, filter: "none" },
      { key: "phone", label: "Phone", value: (l) => l.phone, filter: "text" },
      {
        key: "source",
        label: "Source",
        value: (l) => l.source ?? "",
        display: (v) => (v ? (sourceLabels[v] ?? v) : "Other"),
        filter: "enum",
      },
      { key: "campaign", label: "Campaign", value: (l) => l.campaign ?? "", filter: "text" },
      {
        key: "stage",
        label: "Stage",
        value: (l) => l.stage,
        display: (v) => stageLabels[v] ?? v,
        filter: "enum",
      },
      { key: "tag", label: "Tag", value: (l) => l.tag ?? "", filter: "text" },
      { key: "interest", label: "Treatment", value: (l) => l.interest ?? "", filter: "text" },
      { key: "status", label: "Status", value: (l) => l.status, filter: "enum" },
      {
        key: "assignedRep",
        label: "Owner",
        value: (l) => l.assignedRep ?? "",
        display: (v) => v || "Unassigned",
        filter: "enum",
      },
      {
        key: "nextFollowUp",
        label: "Next follow-up",
        value: (l) => l.nextFollowUp ?? "",
        dateValue: (l) => l.nextFollowUpDate ?? "",
        dateOverdue: (l) => l.nextFollowUpOverdue,
        dateShortcuts: ["today", "tomorrow", "overdue"],
        filter: "date",
      },
      {
        key: "dealAmount",
        label: "Deal amount",
        value: (l) => (l.dealAmount == null ? "" : String(l.dealAmount)),
        filter: "none",
      },
      { key: "calls", label: "Calls", value: (l) => String(l.calls), filter: "enum", number: true },
      { key: "lastCall", label: "Last call", value: (l) => l.lastCall ?? "", filter: "none" },
      {
        key: "cqs",
        label: "CQS",
        value: (l) => (l.cqs == null ? "" : String(l.cqs)),
        display: (v) => (v === "" ? "—" : v),
        filter: "enum",
        number: true,
      },
      { key: "remark", label: "Remark", value: (l) => l.remark ?? "", filter: "text" },
      // History rather than a commitment, so these offer Today/Yesterday and no
      // Overdue — there's nothing to fall behind on.
      {
        key: "created",
        label: "Created",
        value: (l) => l.created,
        dateValue: (l) => l.createdDate,
        dateShortcuts: ["today", "yesterday"],
        filter: "date",
      },
      {
        key: "updated",
        label: "Updated",
        value: (l) => l.updated,
        dateValue: (l) => l.updatedDate,
        dateShortcuts: ["today", "yesterday"],
        filter: "date",
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="w-64 rounded border border-black/15 bg-background px-3 py-1.5 text-sm outline-none focus:border-black/40 dark:border-white/20 dark:focus:border-white/50"
        />
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
      </div>

      <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
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
                <td className="sticky left-0 z-10 whitespace-nowrap border-r border-black/5 bg-background px-4 py-2 dark:border-white/10">
                  <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                    {lead.name}
                  </Link>
                  {lead.duplicateOfId && (
                    <span
                      title="Possible duplicate — no AI call"
                      className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                    >
                      dup
                    </span>
                  )}
                  {lead.optedOut && (
                    <span
                      title="Opted out — all outreach suppressed"
                      className="ml-2 rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-700 dark:text-red-400"
                    >
                      opted out
                    </span>
                  )}
                  {lead.heldForReview && (
                    <span
                      title="Held for review — no AI call"
                      className="ml-2 rounded-full bg-orange-500/15 px-2 py-0.5 text-xs text-orange-700 dark:text-orange-400"
                    >
                      review
                    </span>
                  )}
                  {lead.needsHandover && (
                    <span
                      title={lead.handoverReason ?? "Handover to sales"}
                      className="ml-2 rounded-full bg-purple-500/15 px-2 py-0.5 text-xs text-purple-700 dark:text-purple-400"
                    >
                      handover
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">{lead.phone}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                    {lead.source ? (sourceLabels[lead.source] ?? lead.source) : "—"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  {lead.campaign ? (
                    <span title={lead.adId ? `Ad: ${lead.adId}` : undefined}>{lead.campaign}</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <StageSelect leadId={lead.id} stage={lead.stage} />
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  <TagField leadId={lead.id} tag={lead.tag} />
                </td>
                <td className="px-4 py-2">
                  <span
                    className="block max-w-[200px] truncate"
                    title={lead.interest ?? undefined}
                  >
                    {lead.interest ?? "—"}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2">{lead.status}</td>
                <td className="whitespace-nowrap px-4 py-2">
                  {lead.assignedRep ?? (
                    <span className="text-black/40 dark:text-white/40">Unassigned</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  {lead.nextFollowUp ? (
                    <span
                      title={lead.nextFollowUpTitle ?? undefined}
                      className={
                        lead.nextFollowUpOverdue
                          ? "rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-700 dark:text-red-400"
                          : "text-black/60 dark:text-white/60"
                      }
                    >
                      {lead.nextFollowUp}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                  {lead.dealAmount == null ? (
                    "—"
                  ) : (
                    <span
                      title={
                        lead.dealWon
                          ? "Total of won quotes"
                          : "Latest open quote — not converted yet"
                      }
                      className={lead.dealWon ? "font-medium" : "text-black/60 dark:text-white/60"}
                    >
                      ₹{lead.dealAmount.toLocaleString("en-IN")}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2">{lead.calls}</td>
                <td className="whitespace-nowrap px-4 py-2 text-black/60 dark:text-white/60">
                  {lead.lastCall ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-2">
                  {typeof lead.cqs === "number" ? (
                    <span
                      title="Conversation Quality Score (latest scored call)"
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        lead.cqs >= 75
                          ? "bg-green-600/15 text-green-700 dark:text-green-400"
                          : lead.cqs >= 50
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-red-500/15 text-red-700 dark:text-red-400"
                      }`}
                    >
                      {lead.cqs}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2">
                  {canRemark ? (
                    <RemarkField leadId={lead.id} remark={lead.remark} />
                  ) : (
                    <span
                      className="block max-w-[18rem] truncate text-xs"
                      title={lead.remark ?? undefined}
                    >
                      {lead.remark ?? "—"}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-black/60 dark:text-white/60">
                  {lead.created}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-black/60 dark:text-white/60">
                  {lead.updated}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {canDelete ? (
                    <LeadDeleteButton leadId={lead.id} name={lead.name} />
                  ) : (
                    <span className="text-black/30 dark:text-white/30">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-black/50" colSpan={columns.length + 1}>
                  No leads match the current filters.
                </td>
              </tr>
            )}
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
