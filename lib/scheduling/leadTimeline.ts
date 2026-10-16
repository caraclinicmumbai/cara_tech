// The patient's appointments, treatment plans and intake forms, for the lead page (spec §3,
// rows 3.1 / 3.3 "series status shown on patient timeline"). Before this the lead page knew
// nothing about the calendar: a patient's visits, their six-session plan and the form they
// filled in were reachable only from the appointment card.
//
// The calendar's privacy rule still applies (2.2.b). The viewer can see the LEAD, but an
// appointment at a branch they couldn't see on the calendar shows its time, branch and
// status only — no service, no doctor, no notes — and its intake answers aren't linked.
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/authz";
import { viewerFor, viewerSeesAppointment } from "@/lib/scheduling/calendar";
import { STATUS_LABELS, type AppointmentStatus } from "@/lib/scheduling/status";

export type LeadAppointmentRow = {
  id: string;
  startAt: Date;
  branchId: string;
  branchName: string;
  status: string;
  statusLabel: string;
  visible: boolean;
  typeName: string | null;
  doctorName: string | null;
  cancelReason: string | null;
};

export type LeadPlanRow = {
  id: string;
  name: string;
  status: string;
  done: number;
  total: number;
  next: { label: string; dueFrom: Date; booked: boolean } | null;
  needsReview: boolean;
};

export type LeadIntakeRow = {
  id: string;
  formName: string;
  submittedAt: Date;
  redFlags: number;
  /// false = the viewer can't open these answers (another branch's appointment).
  canOpen: boolean;
};

export async function leadSchedulingTimeline(
  leadId: string,
  user: SessionUser,
): Promise<{ appointments: LeadAppointmentRow[]; plans: LeadPlanRow[]; intake: LeadIntakeRow[] }> {
  const [appts, plans, responses, viewer] = await Promise.all([
    prisma.appointment.findMany({
      where: { leadId, status: { not: "rescheduled" } }, // the reschedule chain shows as its latest row
      orderBy: { startAt: "desc" },
      take: 50,
      select: {
        id: true,
        startAt: true,
        status: true,
        branchId: true,
        cancelReason: true,
        branch: { select: { name: true } },
        type: { select: { name: true } },
        resources: { select: { resource: { select: { kind: true, name: true } } } },
      },
    }),
    prisma.treatmentPlan.findMany({
      where: { leadId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        status: true,
        needsReview: true,
        steps: { orderBy: { order: "asc" }, select: { label: true, status: true, dueFrom: true, appointmentId: true } },
      },
    }),
    prisma.intakeResponse.findMany({
      where: { leadId },
      orderBy: { submittedAt: "desc" },
      select: { id: true, submittedAt: true, redFlags: true, appointmentId: true, form: { select: { name: true } } },
    }),
    viewerFor(user),
  ]);

  const seen = new Map<string, boolean>();
  const sees = async (appointmentId: string) => {
    if (!seen.has(appointmentId)) seen.set(appointmentId, await viewerSeesAppointment(viewer, appointmentId));
    return seen.get(appointmentId)!;
  };

  const appointments: LeadAppointmentRow[] = [];
  for (const a of appts) {
    const visible = await sees(a.id);
    appointments.push({
      id: a.id,
      startAt: a.startAt,
      branchId: a.branchId,
      branchName: a.branch.name,
      status: a.status,
      statusLabel: STATUS_LABELS[a.status as AppointmentStatus] ?? a.status,
      visible,
      typeName: visible ? a.type.name : null,
      doctorName: visible ? (a.resources.find((r) => r.resource.kind === "doctor")?.resource.name ?? null) : null,
      cancelReason: visible ? a.cancelReason : null,
    });
  }

  const planRows: LeadPlanRow[] = plans.map((p) => {
    const counted = p.steps.filter((s) => s.status !== "waived");
    const done = counted.filter((s) => s.status === "completed").length;
    const next = p.steps.find((s) => s.status === "planned" || s.status === "booked");
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      done,
      total: counted.length,
      next: next ? { label: next.label, dueFrom: next.dueFrom, booked: !!next.appointmentId } : null,
      needsReview: p.needsReview,
    };
  });

  const intake: LeadIntakeRow[] = [];
  for (const r of responses) {
    intake.push({
      id: r.id,
      formName: r.form.name,
      submittedAt: r.submittedAt,
      redFlags: Array.isArray(r.redFlags) ? r.redFlags.length : 0,
      canOpen: r.appointmentId ? await sees(r.appointmentId) : true,
    });
  }

  return { appointments, plans: planRows, intake };
}
