import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { LeadForm } from "@/components/LeadForm";
import { StageSelect } from "@/components/StageSelect";
import { TagField } from "@/components/TagField";

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

function SourceBadge({ source }: { source: string | null }) {
  const label = source ? (SOURCE_LABELS[source] ?? source) : "—";
  return (
    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
      {label}
    </span>
  );
}

export default async function LeadsPage() {
  const leads = await prisma.lead.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { calls: true } } },
  });

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">New lead</h1>
        <LeadForm />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Leads ({leads.length})</h2>
        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 dark:bg-white/10 text-left">
              <tr>
                <th className="sticky left-0 z-20 whitespace-nowrap border-r border-black/10 bg-background px-4 py-2 dark:border-white/15">
                  Name
                </th>
                <th className="whitespace-nowrap px-4 py-2">Phone</th>
                <th className="whitespace-nowrap px-4 py-2">Source</th>
                <th className="whitespace-nowrap px-4 py-2">Campaign</th>
                <th className="whitespace-nowrap px-4 py-2">Stage</th>
                <th className="whitespace-nowrap px-4 py-2">Tag</th>
                <th className="whitespace-nowrap px-4 py-2">Interest</th>
                <th className="whitespace-nowrap px-4 py-2">Status</th>
                <th className="whitespace-nowrap px-4 py-2">Calls</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
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
                        title="Held for review — submission burst from one IP, no AI call"
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
                    <SourceBadge source={lead.source} />
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
                  <td className="whitespace-nowrap px-4 py-2">{lead.interest ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2">{lead.status}</td>
                  <td className="whitespace-nowrap px-4 py-2">{lead._count.calls}</td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-black/50" colSpan={9}>
                    No leads yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
