"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveLeadQueue } from "@/lib/leadQueue";
import { leadListFiltered, leadListQuery, type LeadListFilters } from "@/lib/leadList";
import { useCallback, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { StageSelect } from "@/components/StageSelect";
import { TagField } from "@/components/TagField";
import { LeadDeleteButton } from "@/components/LeadDeleteButton";
import { RemarkField } from "@/components/RemarkField";
import {
  IconDuplicate,
  IconStopped,
  IconHeld,
  IconPhone,
  IconOverdue,
  IconUp,
  IconDown,
  IconFlat,
  IconSearch,
} from "@/components/Icon";

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

/// One choice in a multi-select column filter — supplied by the server (lib/leadList.ts).
export type FilterOption = { value: string; label: string };

type Col = {
  /// For a filterable column, its key in the URL (lib/leadList.ts).
  key: string;
  label: string;
  /// What the CELL renders. Every column defines its own, so the header row and the
  /// body row are generated from ONE list and cannot drift apart.
  ///
  /// They used to be two lists — headers mapped from this array, cells hand-written in
  /// a fixed order — and reordering a column silently shifted every cell to its right
  /// under the wrong heading. A table that quietly puts a phone number under "Created"
  /// is worse than one that's ugly, so the two are now the same list by construction.
  cell: (l: LeadRow, ctx: CellContext) => ReactNode;
  dateShortcuts?: DateShortcut[];
  filter: FilterKind;
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
///
/// These used to be four hues (amber / red / orange / purple). They are now four
/// rungs of one ladder — `.tone-*` in globals.css — which renders as those hues
/// under the CARA design and as depth-and-weight under enori, whose brand rules
/// forbid green and red outright. The meaning moved from hue to emphasis:
/// neutral < info < attention < critical, and critical is the only one filled.
/// Each badge answers a different question — is this a duplicate, has this
/// person opted out, is this held, is a counsellor needed — so each needs its
/// own identity, and identity is what one hue cannot give. These come from the
/// supplied tag palette, which measures at ΔE 15.2 between its closest pair
/// where a blue-only set managed 5.6. See the note in globals.css.
/// Fill, outline and GLYPH. The glyph is not decoration — it is the channel
/// that still carries the state in greyscale, under colour blindness, and on a
/// printed page, none of which a block of colour survives.
const BADGE_TONES = {
  duplicate: { cls: "tag tag-aqua", Icon: IconDuplicate },
  stopped: { cls: "tag tag-tangerine", Icon: IconStopped },
  held: { cls: "tag tag-fushia", Icon: IconHeld },
  human: { cls: "tag tag-klein", Icon: IconPhone },
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
  const { cls, Icon } = BADGE_TONES[tone];
  return (
    <span title={title} className={`ml-2 ${cls}`}>
      <Icon size={11} className="tag-icon" />
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

/// How long typing pauses before the search / a "contains" filter reloads the table.
const TYPING_DEBOUNCE_MS = 400;

/// The leads table, one page at a time. `leads` is the page on screen; the search and the
/// column filters are the URL (lib/leadList.ts) — changing one navigates, the server
/// filters, and this re-renders with the new page.
export function LeadsTable({
  leads,
  filters,
  total,
  pageSize,
  options,
  sourceLabels,
  canDelete = false,
  canRemark = false,
}: {
  leads: LeadRow[];
  /// The filters the server applied to produce `leads`.
  filters: LeadListFilters;
  /// How many leads match them, across every page.
  total: number;
  pageSize: number;
  /// The choices in each multi-select filter, by column key.
  options: Record<string, FilterOption[]>;
  sourceLabels: Record<string, string>;
  canDelete?: boolean;
  canRemark?: boolean;
}) {
  const router = useRouter();
  const [loading, startTransition] = useTransition();
  /// What's typed into the search box and the "contains" filters. Kept here rather than
  /// read back from `filters`, so the box doesn't fight the keyboard while the page reloads.
  const [search, setSearch] = useState(filters.q);
  const [textFilters, setTextFilters] = useState<Record<string, string>>(filters.texts);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [openFilter, setOpenFilter] = useState<OpenFilter | null>(null);

  const enumFilters = filters.enums as Record<string, string[] | undefined>;
  /// Date columns filter either to one calendar day ("2026-08-29") or to everything
  /// already past due — the two questions a desk actually asks of a follow-up date.
  const dateFilters = filters.dates as Record<string, { day?: string; overdue?: boolean } | undefined>;

  /// Load the table for `next`. Any change of filter goes back to page 1.
  function go(next: Partial<LeadListFilters>) {
    // A reload still waiting on the keyboard was built from older filters — this one wins.
    if (typingTimer.current) clearTimeout(typingTimer.current);
    const merged: LeadListFilters = {
      ...filters,
      q: search,
      texts: textFilters as LeadListFilters["texts"],
      page: 1,
      ...next,
    };
    const qs = leadListQuery(merged);
    startTransition(() => router.replace(qs ? `/leads?${qs}` : "/leads", { scroll: false }));
  }
  function goSoon(next: Partial<LeadListFilters>) {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => go(next), TYPING_DEBOUNCE_MS);
  }

  const columns: Col[] = useMemo(
    () => [
      {
        key: "name",
        label: "Name",
        filter: "none",
        cell: (l, ctx) => (
          <>
            <Link href={`/leads/${l.id}`} className="font-medium hover:underline" onClick={ctx.onOpenLead}>
              {l.name}
            </Link>
            {l.duplicateOfId && <Badge tone="duplicate" title="Possible duplicate — no AI call">dup</Badge>}
            {l.optedOut && <Badge tone="stopped" title="Opted out — all outreach suppressed">opted out</Badge>}
            {l.heldForReview && <Badge tone="held" title="Held for review — no AI call">review</Badge>}
            {l.needsHandover && (
              <Badge tone="human" title={l.handoverReason ?? "Handover to sales"}>handover</Badge>
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
        dateShortcuts: ["today", "yesterday"],
        filter: "date",
        cell: (l) => <span className={MUTED}>{l.created}</span>,
      },
      { key: "phone", label: "Phone", filter: "text", cell: (l) => l.phone },
      {
        key: "source",
        label: "Source",
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
        filter: "text",
        cell: (l) =>
          l.campaign ? <span title={l.adId ? `Ad: ${l.adId}` : undefined}>{l.campaign}</span> : "—",
      },
      {
        key: "stage",
        label: "Stage",
        filter: "enum",
        cell: (l) => <StageSelect leadId={l.id} stage={l.stage} />,
      },
      {
        key: "tag",
        label: "Tag",
        filter: "text",
        cell: (l) => <TagField leadId={l.id} tag={l.tag} />,
      },
      {
        key: "interest",
        label: "Treatment",
        filter: "text",
        wrap: true,
        cell: (l) => (
          <span className="block max-w-50 truncate" title={l.interest ?? undefined}>
            {l.interest ?? "—"}
          </span>
        ),
      },
      { key: "status", label: "Status", filter: "enum", cell: (l) => l.status },
      {
        key: "owner",
        label: "Owner",
        filter: "enum",
        cell: (l) =>
          l.assignedRep ?? <span className="text-black/40 dark:text-white/40">Unassigned</span>,
      },
      {
        key: "followUp",
        label: "Next follow-up",
        dateShortcuts: ["today", "tomorrow", "overdue"],
        filter: "date",
        cell: (l) =>
          l.nextFollowUp ? (
            <span
              title={l.nextFollowUpTitle ?? undefined}
              className={
                l.nextFollowUpOverdue ? "tag tag-tangerine" : MUTED
              }
            >
              {l.nextFollowUpOverdue && <IconOverdue size={11} className="tag-icon" />}
              {l.nextFollowUp}
            </span>
          ) : (
            "—"
          ),
      },
      {
        key: "dealAmount",
        label: "Deal amount",
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
        filter: "enum",
        cell: (l) => l.calls,
      },
      {
        key: "lastCall",
        label: "Last call",
        filter: "none",
        cell: (l) => <span className={MUTED}>{l.lastCall ?? "—"}</span>,
      },
      {
        key: "cqs",
        label: "CQS",
        filter: "enum",
        cell: (l) =>
          typeof l.cqs === "number" ? (
            <span
              title="Conversation Quality Score (latest scored call)"
              className={`tag ${
                l.cqs >= 75 ? "tag-aqua" : l.cqs >= 50 ? "tag-citric" : "tag-tangerine"
              }`}
            >
              {l.cqs >= 75 ? (
                <IconUp size={11} className="tag-icon" />
              ) : l.cqs >= 50 ? (
                <IconFlat size={11} className="tag-icon" />
              ) : (
                <IconDown size={11} className="tag-icon" />
              )}
              {l.cqs}
            </span>
          ) : (
            "—"
          ),
      },
      {
        key: "remark",
        label: "Remark",
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
        dateShortcuts: ["today", "yesterday"],
        filter: "date",
        cell: (l) => <span className={MUTED}>{l.updated}</span>,
      },
    ],
    [],
  );

  const rows = leads;

  function toggleEnum(key: string, v: string) {
    const set = new Set(enumFilters[key] ?? []);
    if (set.has(v)) set.delete(v);
    else set.add(v);
    go({ enums: { ...filters.enums, [key]: set.size ? Array.from(set) : undefined } });
  }
  function setText(key: string, v: string) {
    const next = { ...textFilters };
    if (v) next[key] = v;
    else delete next[key];
    setTextFilters(next);
    goSoon({ texts: next });
  }
  function setDate(key: string, patch: { day?: string; overdue?: boolean } | null) {
    const keep = patch && (patch.day || patch.overdue) ? patch : undefined;
    go({ dates: { ...filters.dates, [key]: keep } });
  }
  function clearColumn(key: string) {
    const texts = { ...textFilters };
    delete texts[key];
    setTextFilters(texts);
    go({
      enums: { ...filters.enums, [key]: undefined },
      texts,
      dates: { ...filters.dates, [key]: undefined },
    });
  }
  function clearAll() {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    setSearch("");
    setTextFilters({});
    go({ q: "", enums: {}, texts: {}, dates: {} });
  }
  function goToPage(page: number) {
    go({ page });
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
    !!enumFilters[key]?.length || !!textFilters[key] || !!dateFilters[key];
  const anyActive = !!search || leadListFiltered({ ...filters, texts: textFilters });

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (filters.page - 1) * pageSize + 1;
  const lastShown = Math.min(total, filters.page * pageSize);

  const openCol = openFilter ? columns.find((c) => c.key === openFilter.key) : null;

  /// What the current filter is, in words — carried into the lead page so the queue
  /// nav can say which list it's stepping through ("Follow-up: today · Owner: Rohit").
  const filterLabel = useMemo(() => {
    const parts: string[] = [];
    if (search.trim()) parts.push(`"${search.trim()}"`);
    for (const c of columns) {
      const sel = enumFilters[c.key];
      if (sel?.length) {
        const names = sel.map((v) => options[c.key]?.find((o) => o.value === v)?.label ?? v);
        parts.push(`${c.label}: ${names.slice(0, 2).join(", ")}${names.length > 2 ? "…" : ""}`);
      }
      const t = textFilters[c.key]?.trim();
      if (t) parts.push(`${c.label}: ${t}`);
      const d = dateFilters[c.key];
      if (d?.day) parts.push(`${c.label}: ${d.day}`);
      if (d?.overdue) parts.push(`${c.label}: overdue`);
    }
    if (pages > 1) parts.push(`page ${filters.page} of ${pages}`);
    return parts.length ? parts.join(" · ") : "All leads";
  }, [columns, search, enumFilters, textFilters, dateFilters, options, pages, filters.page]);

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
            <IconSearch size={13} />
          </span>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              goSoon({ q: e.target.value });
            }}
            placeholder="Search by name or phone…"
            aria-label="Search leads by name or phone"
            className="w-72 rounded-lg border-2 border-cara-rule bg-cara-surface-2 py-2 pl-9 pr-8 text-sm outline-none transition-colors placeholder:text-cara-faint focus:border-cara-beige-deep focus:bg-cara-page"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                go({ q: "" });
              }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-sm text-cara-muted hover:text-cara-ink"
            >
              ×
            </button>
          )}
        </div>
        <span className="text-sm text-black/50 dark:text-white/50">
          {loading ? "Loading…" : `${firstShown.toLocaleString("en-IN")}–${lastShown.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")}`}
        </span>
        {anyActive && (
          <button onClick={clearAll} className="tone-link text-sm hover:underline">
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
        className={`cara-scroll-x rounded border border-black/10 transition-opacity dark:border-white/15 ${loading ? "opacity-60" : ""}`}
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
                            ? "tone-link"
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
        {rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-cara-muted">
            {anyActive ? "No leads match these filters." : "No leads yet."}
          </p>
        )}
      </div>

      {pages > 1 && (
        <nav className="flex items-center justify-end gap-2 text-sm" aria-label="Leads pages">
          <button
            type="button"
            onClick={() => goToPage(filters.page - 1)}
            disabled={loading || filters.page <= 1}
            className={scrollBtn}
          >
            ‹ Previous
          </button>
          <span className="tabular-nums text-cara-muted">
            Page {filters.page} of {pages}
          </span>
          <button
            type="button"
            onClick={() => goToPage(filters.page + 1)}
            disabled={loading || filters.page >= pages}
            className={scrollBtn}
          >
            Next ›
          </button>
        </nav>
      )}

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
                className="tone-link text-xs hover:underline"
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
                              ? "tone tone-critical border-transparent"
                              : "tone-link border-current"
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
                {(options[openCol.key] ?? []).map(({ value: v, label }) => (
                  <label
                    key={v}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-black/5 dark:hover:bg-white/10"
                  >
                    <input
                      type="checkbox"
                      checked={enumFilters[openCol.key]?.includes(v) ?? false}
                      onChange={() => toggleEnum(openCol.key, v)}
                    />
                    <span className="truncate">{label}</span>
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
