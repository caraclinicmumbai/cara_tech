import { prisma } from "@/lib/prisma";
import { readRecallToken } from "@/lib/scheduling/series";
import { istDateKey } from "@/lib/scheduling/time";
import { RecallBooking } from "@/components/scheduling/RecallBooking";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book your session — Cara Clinic", robots: { index: false, follow: false } };

// The recall link (§2.8): "Your first PRP session is due between 5–19 Nov. Tap to choose
// a time." Shows the due window and free times with the patient's surgeon; the patient
// may pick another branch (2.8.e).
export default async function RecallPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = readRecallToken(token);
  const step = id
    ? await prisma.plannedStep.findUnique({ where: { id }, include: { plan: { include: { lead: { select: { name: true } } } } } })
    : null;
  const branches = await prisma.branch.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const today = istDateKey(new Date());
  return (
    <main className="min-h-screen bg-cara-page px-4 py-8">
      <div className="mx-auto max-w-md space-y-5">
        <div className="text-[20px] font-semibold text-cara-ink" style={{ fontFamily: "var(--font-serif)" }}>Cara Clinic</div>
        {!step ? (
          <div className="cara-card p-5 text-[15px]">This link has expired. Please call the clinic and we&rsquo;ll book you in.</div>
        ) : step.status !== "planned" ? (
          <div className="cara-card p-5 text-[15px]">This session is already {step.status === "booked" ? "booked" : "taken care of"} — thank you.</div>
        ) : (
          <RecallBooking
            token={token}
            firstName={step.plan.lead.name.trim().split(/\s+/)[0] ?? ""}
            label={step.label}
            planName={step.plan.name}
            dueFrom={istDateKey(step.dueFrom)}
            dueTo={istDateKey(new Date(step.dueTo.getTime() - 1))}
            today={today}
            branches={branches}
            defaultBranch={step.plan.branchId}
          />
        )}
      </div>
    </main>
  );
}
