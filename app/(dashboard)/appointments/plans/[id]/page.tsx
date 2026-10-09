import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { mayActAtBranch, viewerFor } from "@/lib/scheduling/calendar";
import { istDateKey } from "@/lib/scheduling/time";
import { PlanView } from "@/components/scheduling/PlanView";

export const dynamic = "force-dynamic";

// A patient's treatment plan (§2.8): every step with its window and status, progress
// ("4 of 7"), the review flag after the anchor moved, and per-step booking / extend /
// waive / re-date — this patient's plan only; the template is untouched.
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCapability("appointments.view");
  const viewer = await viewerFor(user);
  const { id } = await params;
  const plan = await prisma.treatmentPlan.findUnique({
    where: { id },
    include: {
      lead: { select: { name: true, phone: true } },
      steps: { orderBy: { order: "asc" }, include: { appointment: { select: { startAt: true, status: true, branch: { select: { name: true } } } } } },
    },
  });
  if (!plan) notFound();
  const [branch, doctor, types, doctors] = await Promise.all([
    prisma.branch.findUnique({ where: { id: plan.branchId }, select: { name: true } }),
    plan.doctorId ? prisma.resource.findUnique({ where: { id: plan.doctorId }, select: { name: true } }) : null,
    prisma.appointmentType.findMany({ where: { id: { in: plan.steps.map((s) => s.typeId) } }, select: { id: true, name: true } }),
    prisma.resource.findMany({ where: { kind: "doctor", active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const visible = viewer.seesAllBranches || viewer.homeBranchId === plan.branchId;
  if (!visible) {
    return <div className="cara-notice is-info">This plan belongs to another branch.</div>;
  }
  const done = plan.steps.filter((s) => ["completed", "waived"].includes(s.status)).length;
  const now = new Date();
  return (
    <div className="max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="cara-eyebrow">Treatment plan</div>
          <h1 className="cara-title">{plan.lead.name} — {plan.name}</h1>
          <p className="cara-note">
            Anchor {istDateKey(plan.anchorAt)} · {branch?.name}{doctor ? ` · ${doctor.name}` : ""} · <b>{done} of {plan.steps.length} completed</b>
            {plan.status !== "active" ? ` · ${plan.status}` : ""}
          </p>
        </div>
        <div className="flex gap-3 text-[12.5px]">
          <Link href="/appointments/recall" className="tone-link">Recall list</Link>
          <Link href="/appointments" className="tone-link">Calendar</Link>
        </div>
      </header>
      <PlanView
        planId={plan.id}
        active={plan.status === "active"}
        needsReview={plan.needsReview}
        reviewNote={plan.reviewNote}
        canAct={viewer.canBook && mayActAtBranch(viewer, plan.branchId)}
        doctorId={plan.doctorId}
        doctors={doctors}
        today={istDateKey(now)}
        steps={plan.steps.map((s) => ({
          id: s.id,
          order: s.order,
          label: s.label,
          typeName: types.find((t) => t.id === s.typeId)?.name ?? "",
          status: s.status,
          dueFrom: istDateKey(s.dueFrom),
          dueTo: istDateKey(new Date(s.dueTo.getTime() - 1)),
          overdue: s.status === "planned" && s.dueTo < now,
          due: s.status === "planned" && s.dueFrom <= now && s.dueTo >= now,
          appointment: s.appointment ? { startAt: s.appointment.startAt.toISOString(), status: s.appointment.status, branch: s.appointment.branch.name } : null,
          callRequired: s.callRequired,
          recallStage: s.recallStage,
          note: s.note,
        }))}
      />
    </div>
  );
}
