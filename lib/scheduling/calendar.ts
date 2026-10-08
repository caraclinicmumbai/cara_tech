// Calendar data for the appointments desk (§2.2) — branch view and chain view over the
// same appointments, with the privacy rule applied HERE, on the server, so a masked
// appointment never reaches the browser with a patient's name in it.
//
// WHO SEES WHAT (2.2.b): a viewer sees full details for
//   - every branch, if they hold `appointments.viewAllBranches` (call centre, head
//     office, branch managers);
//   - their own (home) branch;
//   - any appointment they are themselves booked on (a doctor's own calendar, across
//     branches).
// Everything else shows as "Booked" — the time and the resources, so free/busy is
// right, but no patient, no service, no notes, no flags.
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { branchIdForUser } from "@/lib/branches";
import type { SessionUser } from "@/lib/authz";
import { dateColumn, istInstant, istMinutes, weekdayOfKey } from "@/lib/scheduling/time";
import { branchDay } from "@/lib/scheduling/hours";
import { isResourceKind, type ResourceKind } from "@/lib/scheduling/status";

export type Viewer = {
  id: string | null;
  role: string | undefined;
  homeBranchId: string | null;
  /// The doctor/staff resource this login is, if any — "my calendar".
  resourceId: string | null;
  seesAllBranches: boolean;
  bookAnyBranch: boolean;
  canBook: boolean;
  canCheckin: boolean;
  canOverride: boolean;
};

export async function viewerFor(user: SessionUser): Promise<Viewer> {
  const [homeBranchId, resource] = await Promise.all([
    branchIdForUser(user.id),
    user.id ? prisma.resource.findUnique({ where: { userId: user.id }, select: { id: true } }) : null,
  ]);
  return {
    id: user.id ?? null,
    role: user.role,
    homeBranchId,
    resourceId: resource?.id ?? null,
    seesAllBranches: can(user.role, "appointments.viewAllBranches"),
    bookAnyBranch: can(user.role, "appointments.bookAnyBranch"),
    canBook: can(user.role, "appointments.book"),
    canCheckin: can(user.role, "appointments.checkin"),
    canOverride: can(user.role, "appointments.override"),
  };
}

/// May this viewer book / move / cancel at this branch? (2.2.c)
export function mayActAtBranch(v: Viewer, branchId: string): boolean {
  return v.bookAnyBranch || (v.homeBranchId !== null && v.homeBranchId === branchId);
}

export type CalendarAppointment = {
  id: string;
  branchId: string;
  branchName: string;
  startAt: string;
  endAt: string;
  status: string;
  /// false = masked: only time, branch and resources are real.
  visible: boolean;
  patientName: string | null;
  leadId: string | null;
  typeName: string | null;
  notes: string | null;
  flags: { label: string; icon: string; tone: string }[];
  doctorOverbooked: boolean;
  overridden: boolean;
  resources: { id: string; name: string; kind: string }[];
};

export type CalendarFilters = {
  branchId: string | null; // null = chain (all branches)
  doctorId?: string | null;
  staffId?: string | null;
  typeId?: string | null;
};

/// Appointments between two instants, filtered and privacy-masked. Rescheduled rows
/// are left out — the replacement row is what the calendar shows.
export async function loadAppointments(
  viewer: Viewer,
  from: Date,
  to: Date,
  f: CalendarFilters,
  opts: { includeCancelled?: boolean; flagsOn?: boolean } = {},
): Promise<CalendarAppointment[]> {
  const resourceFilter = [f.doctorId, f.staffId].filter((x): x is string => !!x);
  const rows = await prisma.appointment.findMany({
    where: {
      startAt: { gte: from, lt: to },
      status: opts.includeCancelled ? { not: "rescheduled" } : { notIn: ["rescheduled", "cancelled"] },
      ...(f.branchId ? { branchId: f.branchId } : {}),
      ...(f.typeId ? { typeId: f.typeId } : {}),
      ...(resourceFilter.length ? { AND: resourceFilter.map((id) => ({ resources: { some: { resourceId: id } } })) } : {}),
    },
    orderBy: { startAt: "asc" },
    include: {
      branch: { select: { name: true } },
      type: { select: { name: true } },
      lead: {
        select: {
          id: true,
          name: true,
          flags: { where: { flag: { active: true } }, select: { flag: { select: { label: true, icon: true, tone: true, sortOrder: true } } } },
        },
      },
      resources: { select: { resource: { select: { id: true, name: true, kind: true } } } },
    },
  });

  return rows.map((a) => {
    const res = a.resources.map((r) => r.resource);
    const visible =
      viewer.seesAllBranches ||
      a.branchId === viewer.homeBranchId ||
      (viewer.resourceId !== null && res.some((r) => r.id === viewer.resourceId));
    const flags =
      visible && opts.flagsOn
        ? [...a.lead.flags].sort((x, y) => x.flag.sortOrder - y.flag.sortOrder).map((x) => ({ label: x.flag.label, icon: x.flag.icon, tone: x.flag.tone }))
        : [];
    return {
      id: a.id,
      branchId: a.branchId,
      branchName: a.branch.name,
      startAt: a.startAt.toISOString(),
      endAt: a.endAt.toISOString(),
      status: a.status,
      visible,
      patientName: visible ? a.lead.name : null,
      leadId: visible ? a.lead.id : null,
      typeName: visible ? a.type.name : null,
      notes: visible ? a.notes : null,
      flags,
      doctorOverbooked: a.doctorOverbooked,
      overridden: !!a.overrideReason,
      // A masked appointment still says WHO is busy (doctor/room), so free/busy is
      // honest; it never says for whom.
      resources: res,
    };
  });
}

export type ColumnResource = {
  id: string;
  name: string;
  kind: ResourceKind;
  subtype: string | null;
  /// Working windows at THIS branch today (roster, or one-off change). Empty with
  /// `rostered: true` = works somewhere else today.
  windows: { startMin: number; endMin: number }[];
  rostered: boolean;
  /// Where else they are today — "at Powai 10:00–17:00" on Andheri's calendar (§2.2).
  elsewhere: { branchName: string; startMin: number; endMin: number }[];
  offToday: string | null; // time-off reason when on leave for the day
};

/// The columns for a branch's resource view on one day: doctors and staff who could
/// work here, plus the branch's rooms and equipment.
export async function loadDayColumns(branchId: string, dateKey: string, kinds: ResourceKind[]): Promise<{
  columns: ColumnResource[];
  open: { startMin: number; endMin: number }[];
  closures: { startMin: number; endMin: number; reason: string }[];
}> {
  const weekday = weekdayOfKey(dateKey);
  const dayStart = istInstant(dateKey, 0);
  const dayEnd = istInstant(dateKey, 24 * 60);
  const [day, rows, branches] = await Promise.all([
    branchDay(prisma, branchId, dateKey),
    prisma.resource.findMany({
      where: {
        active: true,
        kind: { in: kinds },
        OR: [{ branchId }, { branchId: null, kind: { in: ["doctor", "staff"] } }, { schedules: { some: { branchId } } }],
      },
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      include: {
        schedules: { select: { branchId: true, weekday: true, startMin: true, endMin: true } },
        exceptions: { where: { date: dateColumn(dateKey) }, select: { branchId: true, startMin: true, endMin: true } },
        timeOff: { where: { startAt: { lt: dayEnd }, endAt: { gt: dayStart } }, select: { reason: true, startAt: true, endAt: true } },
      },
    }),
    prisma.branch.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(branches.map((b) => [b.id, b.name]));
  const order: Record<string, number> = { doctor: 0, staff: 1, room: 2, equipment: 3 };

  const columns: ColumnResource[] = rows
    .filter((r) => isResourceKind(r.kind))
    .map((r) => {
      const today = r.exceptions.length ? r.exceptions : r.schedules.filter((s) => s.weekday === weekday);
      const isPerson = r.kind === "doctor" || r.kind === "staff";
      const rostered = isPerson && (r.schedules.length > 0 || r.exceptions.length > 0);
      const fullDayOff = r.timeOff.find((t) => t.startAt <= dayStart && t.endAt >= dayEnd);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind as ResourceKind,
        subtype: r.subtype,
        windows: rostered ? today.filter((s) => s.branchId === branchId).map((s) => ({ startMin: s.startMin, endMin: s.endMin })) : day.open,
        rostered,
        elsewhere: rostered
          ? today.filter((s) => s.branchId !== branchId).map((s) => ({ branchName: names.get(s.branchId) ?? "another branch", startMin: s.startMin, endMin: s.endMin }))
          : [],
        offToday: fullDayOff ? (fullDayOff.reason ?? "Unavailable") : null,
      };
    })
    // People rostered only elsewhere today stay visible (so nobody books them here by
    // mistake — they show "at Powai"), but sort after the ones working here.
    .sort((a, b) => order[a.kind] - order[b.kind] || Number(b.windows.length > 0) - Number(a.windows.length > 0));

  return { columns, open: day.open, closures: day.closures };
}

/// Day summary bar (Zenoti's footer): counts the viewer is allowed to see.
export function summarise(appts: CalendarAppointment[]) {
  const live = appts.filter((a) => a.status !== "cancelled");
  const by = (s: string) => live.filter((a) => a.status === s).length;
  return {
    appointments: live.length,
    guests: new Set(live.filter((a) => a.visible && a.leadId).map((a) => a.leadId)).size,
    expected: by("booked") + by("confirmed") + by("tentative"),
    waiting: by("checked_in"),
    inProgress: by("in_progress"),
    completed: by("completed"),
    noShow: by("no_show"),
    overbooked: live.filter((a) => a.doctorOverbooked).length,
  };
}

export function minutesOf(iso: string): number {
  return istMinutes(new Date(iso));
}

/// Where one person works on each day of a week (§2.2 "a doctor's weekly schedule
/// pattern"), for the week view filtered to that doctor: Mon Andheri 10–5, Tue Powai…
/// One-off changes replace the weekly pattern for their date; a full day of leave
/// shows as off.
export async function loadWeekRoster(resourceId: string, dateKeys: string[]): Promise<
  { dateKey: string; places: { branchName: string; startMin: number; endMin: number }[]; off: string | null }[]
> {
  const first = istInstant(dateKeys[0], 0);
  const last = istInstant(dateKeys[dateKeys.length - 1], 24 * 60);
  const [r, branches] = await Promise.all([
    prisma.resource.findUnique({
      where: { id: resourceId },
      include: {
        schedules: true,
        exceptions: { where: { date: { gte: dateColumn(dateKeys[0]), lte: dateColumn(dateKeys[dateKeys.length - 1]) } } },
        timeOff: { where: { startAt: { lt: last }, endAt: { gt: first } } },
      },
    }),
    prisma.branch.findMany({ select: { id: true, name: true } }),
  ]);
  if (!r) return [];
  const names = new Map(branches.map((b) => [b.id, b.name]));
  return dateKeys.map((dateKey) => {
    const dayStart = istInstant(dateKey, 0);
    const dayEnd = istInstant(dateKey, 24 * 60);
    const ex = r.exceptions.filter((e) => e.date.toISOString().slice(0, 10) === dateKey);
    const rows = ex.length ? ex : r.schedules.filter((s) => s.weekday === weekdayOfKey(dateKey));
    const off = r.timeOff.find((t) => t.startAt <= dayStart && t.endAt >= dayEnd);
    return {
      dateKey,
      places: [...rows]
        .sort((a, b) => a.startMin - b.startMin)
        .map((s) => ({ branchName: names.get(s.branchId) ?? "—", startMin: s.startMin, endMin: s.endMin })),
      off: off ? (off.reason ?? "Unavailable") : null,
    };
  });
}
