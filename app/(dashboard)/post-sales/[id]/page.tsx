import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { getJourneyDetail, getAssignableStaff } from "@/lib/postSales/board";
import { buildHandoverSummary } from "@/lib/postSales/handover";
import { getPolicy } from "@/lib/postSales/policy";
import { checkInsEnabled } from "@/lib/postSales/checkins";
import { HandoverSummaryCard } from "@/components/HandoverSummaryCard";
import { JourneyStagePanel } from "@/components/JourneyStagePanel";
import { CheckInSchedule } from "@/components/CheckInSchedule";
import { JourneyNotes } from "@/components/JourneyNotes";

export const dynamic = "force-dynamic";

// A single post-sales journey (§post-sales) — one converted treatment, end to end.
//
// This page is the clinical team's ENTIRE view of the patient. It shows the handover
// summary, the stage clock, the care check-in schedule and the journey's own notes. It
// deliberately shows no call recordings and no transcripts, and it links to the sales
// lead record only for staff who hold `leads.view` (the clinical roles do not).

export default async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCapability("postsales.view");
  const { id } = await params;

  const detail = await getJourneyDetail(id);
  if (!detail) notFound();

  // The summary is recomputed live: the safety flags and "other quotes open" must be
  // current for a clinician, not as they were at conversion.
  const [summary, staff, policy] = await Promise.all([
    buildHandoverSummary(detail.card.quoteId),
    getAssignableStaff(),
    getPolicy(detail.card.treatmentType),
  ]);

  const canManage = can(user.role, "postsales.manage");
  const canCheckIns = can(user.role, "postsales.checkins");
  const canSeeLead = can(user.role, "leads.view");

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/post-sales" className="cara-eyebrow hover:underline">
          ← Post-Sales
        </Link>
        <h1 className="cara-title">{detail.card.patientName}</h1>
        <p className="cara-note">
          {detail.card.procedure}
          {detail.card.cycle > 1 && ` · session ${detail.card.cycle}`}
          {" · "}
          {policy.label} timings{policy.builtIn && " (defaults)"}
          {detail.card.branchName && ` · ${detail.card.branchName}`}
        </p>
      </div>

      {detail.quoteUnlocked && (
        <div className="cara-callout cara-callout-warning">
          An Admin has reopened the invoice/quote behind this journey. The commercial details below may change — the
          reason is recorded in the audit log.
        </div>
      )}

      {summary && <HandoverSummaryCard summary={summary} generatedAt={detail.handoverGeneratedAt} canSeeLead={canSeeLead} />}

      <JourneyStagePanel
        journeyId={detail.card.id}
        stage={detail.card.stage}
        stageDueAt={detail.card.stageDueAt}
        daysInStage={detail.card.daysInStage}
        daysOverdue={detail.card.daysOverdue}
        overdue={detail.card.overdue}
        surgeryAt={detail.card.surgeryAt}
        staff={staff}
        assigned={{
          doctor: detail.card.doctorId,
          otLead: detail.card.otLeadId,
          consultant: detail.card.consultantId,
        }}
        canManage={canManage}
      />

      <CheckInSchedule
        journeyId={detail.card.id}
        checkIns={detail.checkIns}
        surgeryAt={detail.card.surgeryAt}
        scheduleDays={policy.checkInDays}
        automationOn={checkInsEnabled()}
        canManage={canCheckIns}
      />

      {detail.siblings.length > 0 && (
        <section className="cara-card space-y-2 p-4">
          <h2 className="cara-sec-hd">This patient&apos;s other journeys</h2>
          <p className="cara-note">
            Care messages are coordinated across all of them — at most one a day, so the patient sees one relationship,
            not two.
          </p>
          <ul className="space-y-1 text-[13px]">
            {detail.siblings.map((s) => (
              <li key={s.id}>
                <Link href={`/post-sales/${s.id}`} className="hover:underline">
                  {s.procedure}
                </Link>
                <span className="text-cara-faint"> — {s.stage.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <JourneyNotes journeyId={detail.card.id} notes={detail.notes} canWrite={canCheckIns} canDeleteAny={canManage} />
    </div>
  );
}
