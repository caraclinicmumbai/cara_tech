import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { FlagsSetup } from "@/components/scheduling/FlagsSetup";

export const dynamic = "force-dynamic";

// The kinds of flag staff can pin to a patient (§3.2). A flag belongs to the patient, not
// to the calendar, so this sits with the leads rather than in Scheduling setup, where the
// clinic couldn't find it. Still `appointments.configure`, the capability it always had.
export default async function PatientFlagsPage() {
  await requireCapability("appointments.configure");
  const flags = await prisma.flagDefinition.findMany({
    orderBy: [{ active: "desc" }, { sortOrder: "asc" }],
    include: { _count: { select: { leadFlags: true } } },
  });
  return (
    <div className="space-y-6">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">
          <Link href="/leads" className="hover:underline">Leads</Link>
        </div>
        <h1 className="cara-title">Patient flags</h1>
        <p className="cara-note mt-1">
          Define the flags here. To put one on a patient, open their lead page and click it at the top,
          or use their appointment card.
        </p>
      </header>
      <FlagsSetup
        flags={flags.map((f) => ({
          id: f.id,
          label: f.label,
          description: f.description,
          icon: f.icon,
          tone: f.tone,
          active: f.active,
          patients: f._count.leadFlags,
        }))}
      />
    </div>
  );
}
