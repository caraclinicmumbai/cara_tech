import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { formatIst } from "@/lib/datetime";
import { viewerFor } from "@/lib/scheduling/calendar";
import { affectedCount, LEAVE_KIND_LABELS, LEAVE_KINDS } from "@/lib/scheduling/leave";
import { LeavePanel, type LeaveRow } from "@/components/scheduling/LeavePanel";

export const dynamic = "force-dynamic";

// Leave & availability (§2.9). A doctor requests their own leave here; head office
// approves; managers enter leave for anyone or mark a same-day emergency. Approved
// leave blocks the person at every branch at once, and anything already booked inside
// it goes to Needs rebooking — never cancelled by the system.
export default async function LeavePage() {
  const user = await requireCapability("appointments.view");
  const viewer = await viewerFor(user);
  const canApprove = can(user.role, "appointments.approveLeave");
  const isManager = canApprove || can(user.role, "appointments.configure");

  const [rows, people, me] = await Promise.all([
    prisma.resourceTimeOff.findMany({
      where: {
        endAt: { gt: new Date() },
        status: { in: ["requested", "approved"] },
        resource: { kind: { in: ["doctor", "staff"] } },
        // Non-managers see only their own leave.
        ...(isManager ? {} : { resourceId: viewer.resourceId ?? "__none__" }),
      },
      orderBy: [{ status: "desc" }, { startAt: "asc" }],
      include: { resource: { select: { id: true, name: true, userId: true } } },
    }),
    isManager
      ? prisma.resource.findMany({ where: { kind: { in: ["doctor", "staff"] }, active: true }, orderBy: [{ kind: "asc" }, { name: "asc" }], select: { id: true, name: true, kind: true } })
      : Promise.resolve([]),
    viewer.resourceId ? prisma.resource.findUnique({ where: { id: viewer.resourceId }, select: { name: true } }) : null,
  ]);

  const leave: LeaveRow[] = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      resourceName: r.resource.name,
      kind: LEAVE_KIND_LABELS[r.kind as keyof typeof LEAVE_KIND_LABELS] ?? r.kind,
      status: r.status,
      from: formatIst(r.startAt),
      // Shown as the last minute covered: whole-day leave to the 15th reads "15 Oct,
      // 11:59 pm", not "16 Oct, 12:00 am".
      to: formatIst(new Date(r.endAt.getTime() - 60_000)),
      reason: r.reason,
      affected: await affectedCount(r.resourceId, r.startAt, r.endAt),
      mine: r.resource.userId === user.id || r.requestedById === user.id,
    })),
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="cara-eyebrow">Appointments</div>
          <h1 className="cara-title">Leave &amp; availability</h1>
          <p className="cara-note mt-1">
            Approved leave blocks the doctor at every branch at once. Appointments already booked inside it go to{" "}
            <Link href="/appointments/rebooking" className="tone-link">Needs rebooking</Link> — nothing is cancelled automatically.
          </p>
        </div>
        <Link href="/appointments" className="text-[12.5px] tone-link">Back to calendar</Link>
      </header>
      <LeavePanel
        leave={leave}
        myName={me?.name ?? null}
        isManager={isManager}
        canApprove={canApprove}
        people={people.map((p) => ({ id: p.id, name: `${p.name}${p.kind === "staff" ? " (OT team)" : ""}` }))}
        kinds={LEAVE_KINDS.map((k) => ({ key: k, label: LEAVE_KIND_LABELS[k] }))}
      />
    </div>
  );
}
