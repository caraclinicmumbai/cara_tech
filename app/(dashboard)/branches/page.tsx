import { requireCapability } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { listBranches } from "@/lib/branches";
import { CAMPAIGN_TYPES, CAMPAIGNS } from "@/lib/campaigns/types";
import { BranchesAdmin } from "@/components/BranchesAdmin";

export const dynamic = "force-dynamic";

// CRM-Admin screen: create and manage clinic branches. Route-guarded to
// `branches.manage` in the proxy; re-checked here for defense in depth.
export default async function BranchesPage() {
  await requireCapability("branches.manage");

  const [branches, managers] = await Promise.all([
    listBranches(),
    // Managers to assign: branch managers, sales heads, or admins (staff who run a branch).
    prisma.user.findMany({
      where: { role: { in: ["branch_manager", "sales_head", "crm_admin"] } },
      select: { id: true, name: true, email: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const managerOptions = managers.map((m) => ({ id: m.id, label: m.name ? `${m.name} (${m.email})` : m.email }));
  const campaigns = CAMPAIGN_TYPES.map((t) => ({ type: t, label: CAMPAIGNS[t].label, description: CAMPAIGNS[t].description }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Branches</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Create a clinic branch and fill in its legal entity, GSTIN, address, and bank /
          UPI details. Quotes raised at a branch render <em>its</em> details on the PDF. The{" "}
          <span className="font-medium">default</span> branch is used for staff who don&apos;t
          have a branch set yet. (Lead routing by branch comes later.)
        </p>
      </div>
      <BranchesAdmin branches={branches} managerOptions={managerOptions} campaigns={campaigns} />
    </div>
  );
}
