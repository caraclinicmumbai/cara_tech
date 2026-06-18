import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { WalkInForm } from "@/components/WalkInForm";

export const dynamic = "force-dynamic";

// Front-desk walk-in entry (§3.1.1). Consent is captured at the clinic and the
// lead is routed to manual follow-up — never an AI call (§3.1.2 exceptions).
export default async function WalkInPage() {
  const recent = await prisma.lead.findMany({
    where: { source: "walk_in" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-xl font-semibold">Walk-in / front-desk entry</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Log a patient who enquired at the clinic. Collect their consent on the iPad
          or a paper form first — this record is created with consent recorded and is
          sent to the manual follow-up queue. No automated AI call is placed.
        </p>
      </section>

      <WalkInForm />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent walk-ins ({recent.length})</h2>
        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="w-full text-sm">
            <thead className="bg-black/5 dark:bg-white/10 text-left">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2">Interest</th>
                <th className="px-3 py-2">Consent</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((lead) => (
                <tr key={lead.id} className="border-t border-black/5 dark:border-white/10">
                  <td className="px-3 py-2">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                      {lead.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{lead.phone}</td>
                  <td className="px-3 py-2">{lead.interest ?? "—"}</td>
                  <td className="px-3 py-2">
                    {lead.consentMethod ? (
                      <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-700 dark:text-green-400">
                        {lead.consentMethod === "ipad" ? "iPad" : "Written"}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">{lead.status}</td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-black/50" colSpan={5}>
                    No walk-ins logged yet.
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
