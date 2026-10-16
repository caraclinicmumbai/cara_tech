import { requireCapability } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { listBranches } from "@/lib/branches";
import { CAMPAIGN_TYPES, CAMPAIGNS } from "@/lib/campaigns/types";
import { BranchesAdmin } from "@/components/BranchesAdmin";
import { branchWeek } from "@/lib/scheduling/hours";
import { WEEKDAY_LABELS, minutesToHhmm, keyOfDateColumn } from "@/lib/scheduling/time";

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

  // §3 (3.13) — each branch's calendar master data, at a glance. Edited in one place
  // (Appointments → setup), shown here beside the branch it belongs to.
  const today = new Date(new Date().toISOString().slice(0, 10));
  const schedule = await Promise.all(
    branches.map(async (b) => {
      const [{ week, configured }, rooms, closures] = await Promise.all([
        branchWeek(prisma, b.id),
        prisma.resource.findMany({ where: { branchId: b.id, kind: "room", active: true }, select: { name: true }, orderBy: { name: "asc" } }),
        prisma.branchClosure.findMany({
          where: { OR: [{ branchId: b.id }, { branchId: null }], endDate: { gte: today } },
          orderBy: { startDate: "asc" },
          take: 3,
          select: { startDate: true, endDate: true, reason: true },
        }),
      ]);
      const open = week.filter((d) => !d.closed);
      const same = open.length > 0 && open.every((d) => d.openMin === open[0].openMin && d.closeMin === open[0].closeMin);
      const hours =
        open.length === 0
          ? "closed every day"
          : same
            ? `${open.length === 7 ? "Every day" : open.map((d) => WEEKDAY_LABELS[d.weekday]).join(", ")} ${minutesToHhmm(open[0].openMin)}–${minutesToHhmm(open[0].closeMin)}`
            : open.map((d) => `${WEEKDAY_LABELS[d.weekday]} ${minutesToHhmm(d.openMin)}–${minutesToHhmm(d.closeMin)}`).join(" · ");
      return {
        id: b.id,
        name: b.name,
        hours: configured ? hours : `${hours} (default — not set yet)`,
        rooms: rooms.map((r) => r.name),
        closures: closures.map((c) => {
          const from = keyOfDateColumn(c.startDate);
          const to = keyOfDateColumn(c.endDate);
          return `${from}${to !== from ? ` – ${to}` : ""} (${c.reason})`;
        }),
      };
    }),
  );

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

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Opening hours, holidays &amp; rooms</h2>
        <p className="text-sm text-black/60 dark:text-white/60">
          The calendar books against these. They&apos;re edited in{" "}
          <a href="/appointments/setup?tab=hours" className="tone-link">Appointments → setup</a> (hours &amp; holidays) and{" "}
          <a href="/appointments/setup?tab=resources" className="tone-link">resources</a> (rooms).
        </p>
        <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
          <table className="min-w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="px-3 py-2">Branch</th>
                <th className="px-3 py-2">Hours</th>
                <th className="px-3 py-2">Rooms</th>
                <th className="px-3 py-2">Next closures</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((s) => (
                <tr key={s.id} className="border-t border-black/5 align-top dark:border-white/10">
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2">{s.hours}</td>
                  <td className="px-3 py-2">{s.rooms.length ? s.rooms.join(", ") : "—"}</td>
                  <td className="px-3 py-2">{s.closures.length ? s.closures.join("; ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
