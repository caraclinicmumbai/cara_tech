// The leads table, one page at a time (§leads table).
//
// The table used to load EVERY lead the user can see — with every call each one ever had —
// and filter them in the browser. At 10,000 leads that's a multi-second page and a tab
// holding megabytes of rows nobody scrolls to. Now the search box and the column filters
// live in the URL, this module turns them into one Prisma `where`, and the page loads only
// the 50 rows on screen.
//
// The URL is the filter state, so a filtered view survives a refresh, the back button and
// being pasted to a colleague. Repeated keys carry multi-select filters:
//   /leads?q=priya&source=facebook&source=google&created=2026-10-30&page=2
import type { Prisma } from "@prisma/client";

export const LEADS_PAGE_SIZE = 50;

/// Multi-select columns. `owner` values are rep ids, or "none" for unassigned.
export const ENUM_FILTERS = ["source", "stage", "status", "owner", "calls", "cqs"] as const;
/// "Contains" columns.
export const TEXT_FILTERS = ["phone", "campaign", "tag", "interest", "remark"] as const;
/// One calendar day (YYYY-MM-DD, IST) — or "overdue" for the follow-up column.
export const DATE_FILTERS = ["created", "updated", "followUp"] as const;

export type LeadListFilters = {
  q: string;
  enums: Partial<Record<(typeof ENUM_FILTERS)[number], string[]>>;
  texts: Partial<Record<(typeof TEXT_FILTERS)[number], string>>;
  dates: Partial<Record<(typeof DATE_FILTERS)[number], { day?: string; overdue?: boolean }>>;
  page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

const all = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
const one = (v: string | string[] | undefined): string => all(v)[0] ?? "";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/// Read the filters out of the page's searchParams. Anything malformed is dropped, never
/// thrown on — a hand-edited URL shows more leads, not an error page.
export function parseLeadListParams(params: RawParams): LeadListFilters {
  const f: LeadListFilters = { q: one(params.q).slice(0, 100), enums: {}, texts: {}, dates: {}, page: 1 };
  for (const k of ENUM_FILTERS) {
    const v = all(params[k]);
    if (v.length) f.enums[k] = v;
  }
  for (const k of TEXT_FILTERS) {
    const v = one(params[k]).slice(0, 100);
    if (v) f.texts[k] = v;
  }
  for (const k of DATE_FILTERS) {
    const v = one(params[k]);
    if (v === "overdue" && k === "followUp") f.dates[k] = { overdue: true };
    else if (DAY.test(v)) f.dates[k] = { day: v };
  }
  const page = parseInt(one(params.page), 10);
  if (Number.isFinite(page) && page > 1) f.page = page;
  return f;
}

/// The same filters as a query string — what the table navigates to.
export function leadListQuery(f: LeadListFilters): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const k of ENUM_FILTERS) for (const v of f.enums[k] ?? []) p.append(k, v);
  for (const k of TEXT_FILTERS) if (f.texts[k]?.trim()) p.set(k, f.texts[k]!.trim());
  for (const k of DATE_FILTERS) {
    const d = f.dates[k];
    if (d?.overdue) p.set(k, "overdue");
    else if (d?.day) p.set(k, d.day);
  }
  if (f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

/// The instant an IST calendar day starts, and the next one.
function istDayRange(day: string): { gte: Date; lt: Date } {
  const gte = new Date(`${day}T00:00:00+05:30`);
  return { gte, lt: new Date(gte.getTime() + 86_400_000) };
}

const contains = (v: string) => ({ contains: v, mode: "insensitive" as const });

/// The Prisma `where` for these filters, ANDed onto `scope` (who may see which leads).
export function leadListWhere(f: LeadListFilters, scope: Prisma.LeadWhereInput): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [{ deletedAt: null }, scope];

  // Search matches the name, or the number — a caller is often known only by the digits
  // they rang from ("Caller 4021"), so typing part of a phone number has to find them.
  const q = f.q.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    and.push({
      OR: [{ name: contains(q) }, ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : [])],
    });
  }

  const e = f.enums;
  if (e.source?.length) {
    const named = e.source.filter((s) => s !== "none");
    // The "Other" option is a lead with no source at all.
    and.push({ OR: [{ source: { in: named } }, ...(e.source.includes("none") ? [{ source: null }] : [])] });
  }
  if (e.stage?.length) and.push({ stage: { in: e.stage } });
  if (e.status?.length) and.push({ status: { in: e.status } });
  if (e.owner?.length) {
    const ids = e.owner.filter((o) => o !== "none");
    and.push({
      OR: [{ assignedRepId: { in: ids } }, ...(e.owner.includes("none") ? [{ assignedRepId: null }] : [])],
    });
  }
  if (e.calls?.length === 1) and.push(e.calls[0] === "none" ? { calls: { none: {} } } : { calls: { some: {} } });
  if (e.cqs?.length === 1) {
    const scored = { calls: { some: { cqs: { not: null } } } };
    and.push(e.cqs[0] === "none" ? { NOT: scored } : scored);
  }

  const t = f.texts;
  if (t.phone) {
    const digits = t.phone.replace(/\D/g, "");
    and.push({ phone: { contains: digits || t.phone } });
  }
  if (t.campaign) and.push({ campaign: contains(t.campaign) });
  if (t.tag) and.push({ tag: contains(t.tag) });
  if (t.interest) and.push({ interest: contains(t.interest) });
  if (t.remark) and.push({ remark: contains(t.remark) });

  const d = f.dates;
  if (d.created?.day) and.push({ createdAt: istDayRange(d.created.day) });
  if (d.updated?.day) and.push({ updatedAt: istDayRange(d.updated.day) });
  // The column shows the EARLIEST pending step with a due date, so "follow-up on day X"
  // means one is due that day and none is due before it.
  const pending = { status: "pending", dueAt: { not: null } };
  if (d.followUp?.day) {
    const r = istDayRange(d.followUp.day);
    and.push({ followUpSteps: { some: { ...pending, dueAt: r } } });
    and.push({ followUpSteps: { none: { ...pending, dueAt: { lt: r.gte } } } });
  }
  if (d.followUp?.overdue) and.push({ followUpSteps: { some: { ...pending, dueAt: { lt: new Date() } } } });

  return { AND: and };
}

/// Is any filter or search on?
export function leadListFiltered(f: LeadListFilters): boolean {
  return (
    !!f.q.trim() ||
    Object.values(f.enums).some((v) => v?.length) ||
    Object.values(f.texts).some(Boolean) ||
    Object.values(f.dates).some(Boolean)
  );
}
