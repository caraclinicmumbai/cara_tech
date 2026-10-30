import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { LeadForm } from "@/components/LeadForm";
import { LeadsTable, type LeadRow, type FilterOption } from "@/components/LeadsTable";
import { STAGE_LABELS } from "@/lib/leadStages";
import { parseLeadListParams, leadListWhere, LEADS_PAGE_SIZE } from "@/lib/leadList";
import { formatIst, formatIstDate, istDateKey } from "@/lib/datetime";
import { currentUser, leadWhereForUser } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { visualStatus } from "@/lib/followups";
import { OPEN_QUOTE_STATUSES, WON_QUOTE_STATUSES, type QuoteStatus } from "@/lib/quoteStages";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
  walk_in: "Walk-in",
  whatsapp: "WhatsApp",
  inbound_call: "Inbound call",
};

/// The choices in each multi-select column filter. They used to be read off the rows in
/// the browser; with only one page loaded they come from the database, across every lead
/// this user can see.
async function filterOptions(scope: Prisma.LeadWhereInput): Promise<Record<string, FilterOption[]>> {
  const [sources, statuses, owners] = await Promise.all([
    prisma.lead.groupBy({ by: ["source"], where: scope, orderBy: { source: "asc" } }),
    prisma.lead.groupBy({ by: ["status"], where: scope, orderBy: { status: "asc" } }),
    prisma.lead.groupBy({ by: ["assignedRepId"], where: scope }),
  ]);
  const reps = await prisma.salesRep.findMany({
    where: { id: { in: owners.map((o) => o.assignedRepId).filter((id): id is string => !!id) } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return {
    source: sources.map((s) => ({
      value: s.source ?? "none",
      label: s.source ? (SOURCE_LABELS[s.source] ?? s.source) : "Other",
    })),
    stage: Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label })),
    status: statuses.map((s) => ({ value: s.status, label: s.status })),
    owner: [
      ...reps.map((r) => ({ value: r.id, label: r.name })),
      ...(owners.some((o) => !o.assignedRepId) ? [{ value: "none", label: "Unassigned" }] : []),
    ],
    calls: [
      { value: "some", label: "Called" },
      { value: "none", label: "No calls yet" },
    ],
    cqs: [
      { value: "some", label: "Scored" },
      { value: "none", label: "Not scored" },
    ],
  };
}

type QuoteMoney = {
  status: string;
  totalPayable: number | null;
  price: number | null;
  createdAt: Date;
};

/// The lead's headline deal value: the total of every WON quote (converted and
/// beyond — real money). Before anything converts, the latest still-open quote
/// stands in as the value on the table, flagged as not-yet-won.
function dealAmount(quotes: QuoteMoney[]): { dealAmount: number | null; dealWon: boolean } {
  const value = (q: QuoteMoney) => q.totalPayable ?? q.price ?? 0;
  const won = quotes.filter((q) => WON_QUOTE_STATUSES.includes(q.status as QuoteStatus));
  if (won.length > 0) {
    return { dealAmount: won.reduce((sum, q) => sum + value(q), 0), dealWon: true };
  }
  const open = quotes
    .filter((q) => OPEN_QUOTE_STATUSES.includes(q.status as QuoteStatus))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return { dealAmount: open ? value(open) : null, dealWon: false };
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  const filters = parseLeadListParams(await searchParams);
  const scope: Prisma.LeadWhereInput = { deletedAt: null, ...leadWhereForUser(user!) };
  const where = leadListWhere(filters, scope);

  // One page of rows (§leads table) — see lib/leadList.ts for why it isn't all of them.
  const total = await prisma.lead.count({ where });
  const pages = Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE));
  const page = Math.min(filters.page, pages);

  const leads = await prisma.lead.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * LEADS_PAGE_SIZE,
    take: LEADS_PAGE_SIZE,
    include: {
      _count: { select: { calls: true } },
      // Only the last call — for "Last call". The CQS comes from the latest SCORED call,
      // which may be older; that's one query for the whole page, below.
      calls: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
      assignedRep: { select: { name: true } },
      // Next follow-up = earliest pending roadmap step that has a due date.
      followUpSteps: {
        where: { status: "pending", dueAt: { not: null } },
        orderBy: { dueAt: "asc" },
        take: 1,
        select: { dueAt: true, title: true, status: true },
      },
      quotes: { select: { status: true, totalPayable: true, price: true, createdAt: true } },
    },
  });

  const [scored, options] = await Promise.all([
    prisma.call.findMany({
      where: { leadId: { in: leads.map((l) => l.id) }, cqs: { not: null } },
      orderBy: { createdAt: "desc" },
      distinct: ["leadId"],
      select: { leadId: true, cqs: true },
    }),
    filterOptions(scope),
  ]);
  const cqsByLead = new Map(scored.map((c) => [c.leadId, c.cqs]));

  const rows: LeadRow[] = leads.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    source: l.source,
    campaign: l.campaign,
    adId: l.adId,
    stage: l.stage,
    tag: l.tag,
    interest: l.interest,
    status: l.status,
    created: formatIstDate(l.createdAt),
    updated: formatIst(l.updatedAt),
    // IST calendar days for the Created / Updated date filters.
    createdDate: istDateKey(l.createdAt),
    updatedDate: istDateKey(l.updatedAt),
    assignedRep: l.assignedRep?.name ?? null,
    // A due DATE, not a timestamp — the hour a step happens to fall on is an
    // artefact of when the lead came in, and reads as noise in a column.
    nextFollowUp: l.followUpSteps[0]?.dueAt ? formatIstDate(l.followUpSteps[0].dueAt) : null,
    // The IST calendar day, for the date filter on this column.
    nextFollowUpDate: l.followUpSteps[0]?.dueAt ? istDateKey(l.followUpSteps[0].dueAt) : null,
    nextFollowUpTitle: l.followUpSteps[0]?.title ?? null,
    nextFollowUpOverdue: l.followUpSteps[0]
      ? visualStatus(l.followUpSteps[0]) === "missed"
      : false,
    ...dealAmount(l.quotes),
    lastCall: l.calls[0] ? formatIstDate(l.calls[0].createdAt) : null,
    remark: l.remark,
    calls: l._count.calls,
    cqs: cqsByLead.get(l.id) ?? null,
    duplicateOfId: l.duplicateOfId,
    optedOut: l.optedOut,
    heldForReview: l.heldForReview,
    needsHandover: l.needsHandover,
    handoverReason: l.handoverReason,
  }));

  const role = user?.role;
  return (
    <div className="space-y-8">
      {can(role, "leads.create") && (
        <section className="space-y-4">
          <header className="cara-sec-hd">
            <div className="cara-eyebrow">Intake</div>
            <h1 className="cara-title">New lead</h1>
          </header>
          <LeadForm />
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="cara-eyebrow">Leads ({total.toLocaleString("en-IN")})</h2>
          {can(role, "leads.export") && (
            <a
              href="/api/leads/export"
              className="rounded border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            >
              Export CSV
            </a>
          )}
        </div>
        <LeadsTable
          leads={rows}
          filters={{ ...filters, page }}
          total={total}
          pageSize={LEADS_PAGE_SIZE}
          options={options}
          sourceLabels={SOURCE_LABELS}
          canDelete={can(role, "leads.softDelete")}
          canRemark={can(role, "leads.comment")}
        />
      </section>
    </div>
  );
}
