import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { getBoolSetting } from "@/lib/settings";
import { istDateKey } from "@/lib/datetime";
import { schedulingEnabled } from "@/lib/scheduling/booking";
import { PATIENT_FLAGS_ENABLED } from "@/lib/scheduling/toggles";
import { istInstant, istMinutes } from "@/lib/scheduling/time";
import { loadAppointments, loadDayColumns, loadWeekRoster, summarise, viewerFor } from "@/lib/scheduling/calendar";
import { AppointmentsDesk } from "@/components/scheduling/desk/AppointmentsDesk";
import type { DeskQuery } from "@/components/scheduling/desk/types";
import { addDays, weekStart } from "@/components/scheduling/desk/ui";

export const dynamic = "force-dynamic";

// Appointments (§3.2 / §2.2): the branch view and the chain view of one calendar.
//   - Front desk opens on their own branch, as resource columns (2.2 "default for
//     front-desk staff").
//   - A doctor opens on their OWN calendar across every branch.
//   - The call centre / head office pick "All branches" for the chain view.
// Privacy (2.2.b) is applied in lib/scheduling/calendar.ts before anything reaches
// the page: other branches' appointments arrive as "Booked".

const VIEW_KEYS = ["resources", "list", "week", "board", "find"] as const;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireCapability("appointments.view");
  const sp = await searchParams;
  const enabled = await schedulingEnabled();
  const viewer = await viewerFor(user);
  const today = istDateKey(new Date());

  const [branches, doctors, staff, typeRows, flagsOn] = await Promise.all([
    prisma.branch.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.resource.findMany({ where: { kind: "doctor", active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.resource.findMany({ where: { kind: "staff", active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.appointmentType.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, category: true, durationMin: true, bufferAfterMin: true, requirements: { select: { kind: true, resourceId: true } } },
    }),
    getBoolSetting(PATIENT_FLAGS_ENABLED),
  ]);
  const types = typeRows.map((t) => ({
    id: t.id,
    label: t.category ? `${t.category} — ${t.name}` : t.name,
    durationMin: t.durationMin,
    bufferAfterMin: t.bufferAfterMin,
    needsDoctor: t.requirements.some((r) => r.kind === "doctor" && !r.resourceId),
  }));

  // Defaults per person: a doctor sees their own calendar chain-wide; everyone else
  // their home branch.
  const isDoctorView = !!viewer.resourceId && doctors.some((d) => d.id === viewer.resourceId);
  const branchParam = one(sp.branch);
  const defaultBranch = isDoctorView ? "all" : (viewer.homeBranchId ?? branches[0]?.id ?? "all");
  const branch = branchParam === "all" || branches.some((b) => b.id === branchParam) ? branchParam : defaultBranch;
  const viewParam = one(sp.view);
  const query: DeskQuery = {
    view: (VIEW_KEYS as readonly string[]).includes(viewParam) ? (viewParam as DeskQuery["view"]) : branch === "all" ? "list" : "resources",
    date: /^\d{4}-\d{2}-\d{2}$/.test(one(sp.date)) ? one(sp.date) : today,
    branch,
    doctor: one(sp.doctor) || (isDoctorView && !sp.doctor ? (viewer.resourceId ?? "") : ""),
    staff: one(sp.staff),
    type: one(sp.type),
  };

  if (!enabled) {
    return (
      <div className="space-y-4">
        <h1 className="cara-title">Appointments</h1>
        <div className="cara-notice is-warn">
          The appointments module is switched off.{" "}
          {can(user.role, "appointments.configure") && <Link href="/appointments/setup" className="tone-link">Scheduling setup</Link>}
        </div>
      </div>
    );
  }

  const chain = query.branch === "all";
  const filters = { branchId: chain ? null : query.branch, doctorId: query.doctor || null, staffId: query.staff || null, typeId: query.type || null };
  const weekKeys = Array.from({ length: 7 }, (_, i) => addDays(weekStart(query.date), i));
  const [fromKey, toKey] = query.view === "week" ? [weekKeys[0], addDays(weekKeys[6], 1)] : [query.date, addDays(query.date, 1)];

  const [appts, day, roster] = await Promise.all([
    query.view === "find" ? Promise.resolve([]) : loadAppointments(viewer, istInstant(fromKey, 0), istInstant(toKey, 0), filters, { flagsOn }),
    query.view === "resources" && !chain
      ? loadDayColumns(query.branch, query.date, ["doctor", "staff", "room", "equipment"])
      : Promise.resolve({ columns: [], open: [], closures: [] }),
    query.view === "week" && (query.doctor || query.staff) ? loadWeekRoster(query.doctor || query.staff, weekKeys) : Promise.resolve(null),
  ]);

  // Column filters: a doctor / OT-team filter narrows the columns too.
  const columns = day.columns.filter(
    (c) => (!query.doctor || c.kind !== "doctor" || c.id === query.doctor) && (!query.staff || c.kind !== "staff" || c.id === query.staff),
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="cara-eyebrow">Appointments</div>
          <h1 className="cara-title">{chain ? "Chain calendar" : "Branch calendar"}</h1>
        </div>
        {can(user.role, "appointments.configure") && (
          <Link href="/appointments/setup" className="text-[12.5px] tone-link">Scheduling setup</Link>
        )}
      </header>
      {types.length === 0 && (
        <div className="cara-notice is-info">
          No appointment types yet — {can(user.role, "appointments.configure") ? <Link href="/appointments/setup?tab=types" className="tone-link">set them up</Link> : "ask a branch manager to set them up"}.
        </div>
      )}
      <AppointmentsDesk
        query={query}
        today={today}
        nowMin={istMinutes(new Date())}
        nowMs={new Date().getTime()}
        viewer={{
          homeBranchId: viewer.homeBranchId,
          resourceId: viewer.resourceId,
          canBook: viewer.canBook,
          canCheckin: viewer.canCheckin,
          canOverride: viewer.canOverride,
          bookAnyBranch: viewer.bookAnyBranch,
          seesAllBranches: viewer.seesAllBranches,
        }}
        branches={branches}
        doctors={doctors}
        staff={staff}
        types={types}
        appts={appts}
        columns={columns}
        open={day.open}
        closures={day.closures}
        roster={roster}
        summary={summarise(appts)}
      />
    </div>
  );
}
