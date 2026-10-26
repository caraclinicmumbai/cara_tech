import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { formatIst } from "@/lib/datetime";
import { mayActAtBranch, viewerFor } from "@/lib/scheduling/calendar";
import { recheckOpenCases } from "@/lib/scheduling/conflicts";
import { RebookingList, type CaseRow } from "@/components/scheduling/RebookingList";

export const dynamic = "force-dynamic";

// Needs rebooking (§2.9): appointments stranded by leave, a roster change or downtime.
// Each has an owner (the branch manager) and a due time; past it, it escalates. The
// system suggests alternatives; a person chooses, and the patient is told.
export default async function RebookingPage() {
  const user = await requireCapability("appointments.book");
  const viewer = await viewerFor(user);
  // Tidy first: close cases whose appointment was cancelled / moved, or fits again.
  await recheckOpenCases({});
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const rows = await prisma.rebookingCase.findMany({
    where: {
      OR: [
        { status: { in: ["open", "proposed", "patient_declined"] } },
        { resolvedAt: { gt: weekAgo } },
      ],
      ...(viewer.bookAnyBranch ? {} : { branchId: viewer.homeBranchId ?? "__none__" }),
    },
    orderBy: [{ urgent: "desc" }, { dueAt: "asc" }],
    include: {
      appointment: {
        include: {
          lead: { select: { name: true, phone: true } },
          branch: { select: { name: true } },
          type: { select: { name: true } },
          resources: { include: { resource: { select: { name: true, kind: true } } } },
        },
      },
    },
  });
  const owners = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.ownerId).filter((x): x is string => !!x) } },
    select: { id: true, name: true, email: true },
  });

  const cases: CaseRow[] = rows.map((c) => ({
    id: c.id,
    status: c.status,
    cause: c.cause,
    reason: c.reason,
    urgent: c.urgent,
    overdue: ["open", "patient_declined"].includes(c.status) && c.dueAt < now,
    due: formatIst(c.dueAt),
    patient: c.appointment.lead.name,
    phone: c.appointment.lead.phone,
    when: formatIst(c.appointment.startAt),
    branch: c.appointment.branch.name,
    service: c.appointment.type.name,
    doctor: c.appointment.resources.find((r) => r.resource.kind === "doctor")?.resource.name ?? null,
    owner: owners.find((o) => o.id === c.ownerId)?.name ?? owners.find((o) => o.id === c.ownerId)?.email ?? null,
    note: c.resolutionNote,
    canAct: mayActAtBranch(viewer, c.branchId),
  }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="cara-eyebrow">Appointments</div>
          <h1 className="cara-title">Needs rebooking</h1>
          <p className="cara-note mt-1">
            Appointments that no longer fit because a doctor is away, a roster changed or a machine is down. Nothing here was cancelled — pick an
            alternative and the patient is told.
          </p>
        </div>
        <div className="flex gap-3 text-[12.5px]">
          <Link href="/appointments/leave" className="tone-link">Leave</Link>
          <Link href="/appointments" className="tone-link">Back to calendar</Link>
        </div>
      </header>
      <RebookingList cases={cases} />
    </div>
  );
}
