import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { ROLES, ROLE_LABELS } from "@/lib/rbac";
import { UsersAdmin } from "@/components/UsersAdmin";

export const dynamic = "force-dynamic";

// CRM-Admin screen: manage staff logins (roles + rep links) and the sales-rep roster.
// Route-guarded to `users.manage` in proxy; re-checked here for defense in depth.
export default async function UsersPage() {
  await requireCapability("users.manage");

  const [users, reps, branches] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, role: true, salesRepId: true, branchId: true },
    }),
    prisma.salesRep.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        phone: true,
        slackUserId: true,
        active: true,
        salesHead: true,
        branchId: true,
        speciality: true,
        availability: true,
        user: { select: { email: true } },
      },
    }),
    prisma.branch.findMany({
      where: { active: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, code: true },
    }),
  ]);

  const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));
  const branchOptions = branches.map((b) => ({ id: b.id, label: `${b.name} (${b.code})` }));
  const repRows = reps.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    slackUserId: r.slackUserId,
    active: r.active,
    salesHead: r.salesHead,
    branchId: r.branchId,
    speciality: r.speciality,
    availability: r.availability,
    userEmail: r.user?.email ?? null,
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Users &amp; roles</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Create staff logins, set their role, and link telecallers/managers to a
          sales-rep identity so they receive their leads.
        </p>
      </div>
      <UsersAdmin users={users} reps={repRows} roleOptions={roleOptions} branchOptions={branchOptions} />
    </div>
  );
}
