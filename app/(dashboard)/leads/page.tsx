import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { LeadForm } from "@/components/LeadForm";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
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
          <table className="w-full text-sm">
            <thead className="bg-black/5 dark:bg-white/10 text-left">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Interest</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Calls</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-3 py-2">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                      {lead.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{lead.phone}</td>
                  <td className="px-3 py-2">
                    <SourceBadge source={lead.source} />
                  </td>
                  <td className="px-3 py-2">{lead.interest ?? "—"}</td>
                  <td className="px-3 py-2">{lead.status}</td>
                  <td className="px-3 py-2">{lead._count.calls}</td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-black/50" colSpan={6}>
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
