import { prisma } from "@/lib/prisma";
import { LeadForm } from "@/components/LeadForm";
import { LeadsTable, type LeadRow } from "@/components/LeadsTable";
import { STAGE_LABELS } from "@/lib/leadStages";
import { currentUser, leadWhereForUser } from "@/lib/authz";
import { can } from "@/lib/rbac";

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

export default async function LeadsPage() {
  const user = await currentUser();
  const leads = await prisma.lead.findMany({
    where: { deletedAt: null, ...leadWhereForUser(user!) },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { calls: true } },
      // Latest scored call → the lead's current CQS shown in the table.
      calls: {
        where: { cqs: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { cqs: true },
      },
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
    calls: l._count.calls,
    cqs: l.calls[0]?.cqs ?? null,
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
        />
      </section>
    </div>
  );
}
