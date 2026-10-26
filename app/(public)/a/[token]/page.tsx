import { prisma } from "@/lib/prisma";
import { getBoolSetting } from "@/lib/settings";
import { appointmentToken, verifyAppointmentToken } from "@/lib/scheduling/links";
import { SELF_SERVICE_LINKS } from "@/lib/scheduling/toggles";
import { istDateKey } from "@/lib/scheduling/time";
import { PatientAppointment } from "@/components/scheduling/PatientAppointment";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your appointment — Cara Clinic", robots: { index: false, follow: false } };

// The patient's appointment page (§2.4) — opened from a reminder, no login. The token
// is the credential. A link to an appointment that has since been moved follows the
// move and shows the new time (with its own fresh token for any further change).
export default async function PatientAppointmentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = verifyAppointmentToken(token);
  if (!v) return <Shell><p className="text-[15px]">This link has expired or isn&rsquo;t valid. Please call the clinic and we&rsquo;ll help you.</p></Shell>;

  let appt = await prisma.appointment.findUnique({ where: { id: v.appointmentId }, include: { rescheduledTo: { select: { id: true } } } });
  let moved = false;
  // Follow the reschedule chain to the current booking (bounded).
  for (let i = 0; i < 10 && appt?.status === "rescheduled" && appt.rescheduledTo; i++) {
    appt = await prisma.appointment.findUnique({ where: { id: appt.rescheduledTo.id }, include: { rescheduledTo: { select: { id: true } } } });
    moved = true;
  }
  if (!appt) return <Shell><p>Appointment not found. Please call the clinic.</p></Shell>;

  const a = await prisma.appointment.findUniqueOrThrow({
    where: { id: appt.id },
    include: {
      lead: { select: { name: true } },
      type: { select: { name: true, prepInstructions: true, selfServiceCutoffHours: true } },
      branch: { select: { name: true, addressLine1: true, addressLine2: true, city: true, phone: true } },
      resources: { include: { resource: { select: { name: true, kind: true } } } },
    },
  });
  const selfService = await getBoolSetting(SELF_SERVICE_LINKS);
  const now = new Date();
  const hoursLeft = (a.startAt.getTime() - now.getTime()) / 3_600_000;
  const live = ["booked", "confirmed"].includes(a.status);
  const address = [a.branch.addressLine1, a.branch.addressLine2, a.branch.city].filter(Boolean).join(", ");

  return (
    <Shell>
      <PatientAppointment
        token={appointmentToken(a.id, a.endAt)}
        moved={moved}
        firstName={a.lead.name.trim().split(/\s+/)[0] ?? ""}
        service={a.type.name}
        startAt={a.startAt.toISOString()}
        endAt={a.endAt.toISOString()}
        status={a.status}
        branch={a.branch.name}
        address={address}
        mapLink={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || a.branch.name)}`}
        phone={a.branch.phone}
        doctor={a.resources.find((r) => r.resource.kind === "doctor")?.resource.name ?? null}
        prep={a.type.prepInstructions}
        canConfirm={a.status === "booked" && a.startAt > now}
        canChange={live && selfService && hoursLeft >= a.type.selfServiceCutoffHours}
        callRequired={live && a.startAt > now && !(selfService && hoursLeft >= a.type.selfServiceCutoffHours)}
        cutoffHours={a.type.selfServiceCutoffHours}
        today={istDateKey(now)}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-cara-page px-4 py-8">
      <div className="mx-auto max-w-md space-y-5">
        <div className="text-[20px] font-semibold text-cara-ink" style={{ fontFamily: "var(--font-serif)" }}>Cara Clinic</div>
        {children}
      </div>
    </main>
  );
}
