import { notFound } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { ensurePermissions } from "@/lib/permissions";
import { can } from "@/lib/rbac";
import { istDateKey } from "@/lib/datetime";
import { loadCalendar, taskAssignees } from "@/lib/calendar/service";
import { PersonalCalendar } from "@/components/calendar/PersonalCalendar";
import { CAL_VIEWS, type CalView } from "@/lib/calendar/types";
import { addDays, weekStart } from "@/components/scheduling/desk/ui";

export const dynamic = "force-dynamic";

// My calendar: everyone's own appointments, lead follow-ups, tasks and blocked time
// (lib/calendar/service.ts). A manager (`calendar.viewOthers`) picks a colleague with ?user=.
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireUser();
  await ensurePermissions();
  if (!user.id) notFound();
  const sp = await searchParams;
  const today = istDateKey(new Date());

  const viewParam = one(sp.view);
  const view: CalView = (CAL_VIEWS.map((v) => v.key) as string[]).includes(viewParam) ? (viewParam as CalView) : "week";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(one(sp.date)) ? one(sp.date) : today;
  const viewOthers = can(user.role, "calendar.viewOthers");
  const ownerId = viewOthers && one(sp.user) ? one(sp.user) : user.id;

  const fromKey = view === "day" ? date : weekStart(date);
  const toKey = view === "day" ? date : addDays(fromKey, 6);

  const [data, assignees] = await Promise.all([loadCalendar(user, ownerId, fromKey, toKey), taskAssignees()]);
  if (!data) notFound();

  return (
    <div className="space-y-4">
      <header className="cara-sec-hd">
        <h1 className="cara-title">{data.owner.isSelf ? "My calendar" : `${data.owner.name}'s calendar`}</h1>
        <p className="cara-note mt-1">
          {[
            data.owner.hasResource && "appointments",
            data.owner.hasRep && "lead follow-ups",
            "tasks",
            "blocked time",
          ]
            .filter(Boolean)
            .join(", ")
            .replace(/^./, (c) => c.toUpperCase())}
        </p>
      </header>
      <PersonalCalendar
        data={data}
        view={view}
        date={date}
        today={today}
        nowIso={new Date().toISOString()}
        people={viewOthers ? assignees : []}
        assignees={assignees}
        meId={user.id}
        canBlockHere={data.owner.isSelf || user.role === "crm_admin"}
      />
    </div>
  );
}
