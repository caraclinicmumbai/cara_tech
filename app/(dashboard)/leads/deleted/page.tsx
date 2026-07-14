import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/datetime";
import { DeletedLeadActions } from "@/components/DeletedLeadActions";
import { currentUser } from "@/lib/authz";
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

// Trash for soft-deleted leads (§3.1). Restore back to the active list, or remove
// permanently (which also deletes the lead's calls + messages).
export default async function DeletedLeadsPage() {
  const user = await currentUser();
  const canPurge = can(user?.role, "leads.permanentDelete");
  const leads = await prisma.lead.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    include: { _count: { select: { calls: true } } },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Deleted leads ({leads.length})</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Leads moved to trash. They&apos;re hidden from the main list, metrics, and
          calling. <span className="font-medium">Restore</span> puts one back;{" "}
          <span className="font-medium">Delete permanently</span> removes it and its
          calls &amp; messages for good.
        </p>
      </div>

      {leads.length === 0 ? (
        <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
          No deleted leads.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="whitespace-nowrap px-4 py-2">Name</th>
                <th className="whitespace-nowrap px-4 py-2">Phone</th>
                <th className="whitespace-nowrap px-4 py-2">Source</th>
                <th className="whitespace-nowrap px-4 py-2">Calls</th>
                <th className="whitespace-nowrap px-4 py-2">Deleted</th>
                <th className="whitespace-nowrap px-4 py-2">Deleted by</th>
                <th className="whitespace-nowrap px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-t border-black/5 dark:border-white/10">
                  <td className="whitespace-nowrap px-4 py-2">
                    <Link href={`/leads/${lead.id}`} className="font-medium hover:underline">
                      {lead.name}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{lead.phone}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                      {lead.source ? (SOURCE_LABELS[lead.source] ?? lead.source) : "—"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{lead._count.calls}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {lead.deletedAt ? formatIst(lead.deletedAt) : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">{lead.deletedBy ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <DeletedLeadActions leadId={lead.id} name={lead.name} canPurge={canPurge} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
