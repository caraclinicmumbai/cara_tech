import { prisma } from "@/lib/prisma";
import { LeadForm } from "@/components/LeadForm";
import { LeadsTable, type LeadRow } from "@/components/LeadsTable";
import { STAGE_LABELS } from "@/lib/leadStages";
import { formatIst, formatIstDate } from "@/lib/datetime";
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
};

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

export default async function LeadsPage() {
  const user = await currentUser();
  const leads = await prisma.lead.findMany({
    where: { deletedAt: null, ...leadWhereForUser(user!) },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { calls: true } },
      // Newest first: [0] is the last call, and the first entry with a cqs is the
      // latest SCORED call (which may be older) → the lead's current CQS.
      calls: {
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, cqs: true },
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
    assignedRep: l.assignedRep?.name ?? null,
    // A due DATE, not a timestamp — the hour a step happens to fall on is an
    // artefact of when the lead came in, and reads as noise in a column.
    nextFollowUp: l.followUpSteps[0]?.dueAt ? formatIstDate(l.followUpSteps[0].dueAt) : null,
    nextFollowUpTitle: l.followUpSteps[0]?.title ?? null,
    nextFollowUpOverdue: l.followUpSteps[0]
      ? visualStatus(l.followUpSteps[0]) === "missed"
      : false,
    ...dealAmount(l.quotes),
    lastCall: l.calls[0] ? formatIstDate(l.calls[0].createdAt) : null,
    remark: l.remark,
    calls: l._count.calls,
    cqs: l.calls.find((c) => c.cqs != null)?.cqs ?? null,
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
          <h2 className="cara-eyebrow">Leads ({rows.length})</h2>
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
          sourceLabels={SOURCE_LABELS}
          stageLabels={STAGE_LABELS}
          canDelete={can(role, "leads.softDelete")}
          canRemark={can(role, "leads.comment")}
        />
      </section>
    </div>
  );
}
