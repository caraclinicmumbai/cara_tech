import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { istDateKey } from "@/lib/datetime";
import { schedulingEnabled } from "@/lib/scheduling/booking";
import { SlotFinder } from "@/components/scheduling/SlotFinder";

export const dynamic = "force-dynamic";

// Appointments (§3.2). Today: Find a slot — the §2.1 search that only offers times
// when the named doctor, the room and the OT team are all free, says why a day
// fails, and offers the next day that works. The calendar and booking land in Phase B.
export default async function AppointmentsPage() {
  const user = await requireCapability("appointments.view");
  const enabled = await schedulingEnabled();

  const [branches, types, doctors] = await Promise.all([
    prisma.branch.findMany({
      where: { active: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
    prisma.appointmentType.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        category: true,
        durationMin: true,
        bufferAfterMin: true,
        requirements: { select: { kind: true, resourceId: true } },
      },
    }),
    prisma.resource.findMany({
      where: { kind: "doctor", active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">Appointments</div>
        <h1 className="cara-title">Find a slot</h1>
        <p className="cara-note mt-1">
          Only times when the chosen doctor, a room and the OT team are all free are offered. A doctor or
          machine that&rsquo;s already busy is shown as a warning, not hidden.
        </p>
      </header>

      {!enabled && <div className="cara-notice is-warn">The appointments module is switched off in Scheduling setup.</div>}
      {enabled && types.length === 0 && (
        <div className="cara-notice is-info">
          No appointment types yet.{" "}
          {can(user.role, "appointments.configure") ? (
            <Link href="/appointments/setup?tab=types" className="tone-link">Set them up</Link>
          ) : (
            "Ask a branch manager to set them up."
          )}
        </div>
      )}

      {enabled && types.length > 0 && (
        <SlotFinder
          branches={branches}
          doctors={doctors}
          today={istDateKey(new Date())}
          types={types.map((t) => ({
            id: t.id,
            label: t.category ? `${t.category} — ${t.name}` : t.name,
            durationMin: t.durationMin,
            bufferAfterMin: t.bufferAfterMin,
            needsDoctor: t.requirements.some((r) => r.kind === "doctor" && !r.resourceId),
          }))}
        />
      )}
    </div>
  );
}
