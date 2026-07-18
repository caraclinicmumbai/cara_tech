import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/datetime";
import { currentUser, leadWhereForUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const user = await currentUser();
  const calls = await prisma.call.findMany({
    // Scope to the viewer's leads (front-desk/telecaller = own; others = all).
    where: { lead: { deletedAt: null, ...leadWhereForUser(user!) } },
    orderBy: { createdAt: "desc" },
    include: { lead: true, handledBy: { select: { name: true } } },
    take: 100,
  });

  return (
    <div className="space-y-4">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">History</div>
        <h1 className="cara-title">Call history ({calls.length})</h1>
      </header>
      <div className="cara-card overflow-x-auto">
        <table className="cara-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Type</th>
              <th>Handled by</th>
              <th>Outcome</th>
              <th>Sentiment</th>
              <th>Duration</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.id}>
                <td>
                  <Link href={`/leads/${call.leadId}`} className="font-medium text-cara-ink hover:underline">
                    {call.lead.name}
                  </Link>
                </td>
                <td>{call.callType}</td>
                <td>
                  {call.callType === "human_handover"
                    ? `👤 ${call.handledBy?.name ?? "—"}`
                    : "🤖 AI"}
                </td>
                <td>{call.outcome ?? "—"}</td>
                <td>{call.sentiment ?? "—"}</td>
                <td>{call.duration ? `${call.duration}s` : "—"}</td>
                <td className="text-cara-muted">{formatIst(call.createdAt)}</td>
              </tr>
            ))}
            {calls.length === 0 && (
              <tr>
                <td className="text-center text-cara-faint" colSpan={7}>
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
