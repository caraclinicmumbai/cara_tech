import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const calls = await prisma.call.findMany({
    orderBy: { createdAt: "desc" },
    include: { lead: true },
    take: 100,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Call history ({calls.length})</h1>
      <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
        <table className="w-full text-sm">
          <thead className="bg-black/5 dark:bg-white/10 text-left">
            <tr>
              <th className="px-3 py-2">Lead</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Outcome</th>
              <th className="px-3 py-2">Sentiment</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.id} className="border-t border-black/5 dark:border-white/10">
                <td className="px-3 py-2">
                  <Link href={`/leads/${call.leadId}`} className="font-medium hover:underline">
                    {call.lead.name}
                  </Link>
                </td>
                <td className="px-3 py-2">{call.callType}</td>
                <td className="px-3 py-2">{call.outcome ?? "—"}</td>
                <td className="px-3 py-2">{call.sentiment ?? "—"}</td>
                <td className="px-3 py-2">{call.duration ? `${call.duration}s` : "—"}</td>
                <td className="px-3 py-2">{call.createdAt.toLocaleString()}</td>
              </tr>
            ))}
            {calls.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-black/50" colSpan={6}>
                  No calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
