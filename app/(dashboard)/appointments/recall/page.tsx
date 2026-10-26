import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { getBoolSetting } from "@/lib/settings";
import { viewerFor } from "@/lib/scheduling/calendar";
import { recallList } from "@/lib/scheduling/series";
import { RECALL_ENABLED } from "@/lib/scheduling/toggles";

export const dynamic = "force-dynamic";

// The branch recall list (§2.8): treatment-plan sessions that are overdue, due this
// week, or due in the next 30 days and NOT booked yet — the patient-care team's
// worklist for keeping patients on their course.
type RecallRows = Awaited<ReturnType<typeof recallList>>["overdue"];
const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

function Section({ title, rows, tone, now }: { title: string; rows: RecallRows; tone: string; now: Date }) {
  return (
    <section className="space-y-2">
      <h2 className="cara-eyebrow">{title} ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="cara-note">None.</p>
      ) : (
        <div className="cara-card overflow-x-auto">
          <table className="cara-table">
            <thead>
              <tr><th>Patient</th><th>Session</th><th>Due</th><th>Recall</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">
                    <div className="font-medium">{r.plan.lead.name}</div>
                    <a href={`tel:${r.plan.lead.phone}`} className="text-[12px] tone-link">{r.plan.lead.phone}</a>
                  </td>
                  <td>
                    <div>{r.label}</div>
                    <div className="text-[11.5px] text-cara-muted">{r.plan.name}</div>
                  </td>
                  <td className="whitespace-nowrap">
                    <span className={`tag tag-${tone}`}>{fmt.format(r.dueFrom)} – {fmt.format(new Date(r.dueTo.getTime() - 1))}</span>
                    {r.dueTo < now && <div className="text-[11.5px] txt-bad">overdue {Math.ceil((now.getTime() - r.dueTo.getTime()) / 86_400_000)} days</div>}
                  </td>
                  <td className="text-[12px]">
                    {r.callRequired ? <span className="tag tag-fushia">call required</span> : r.recallStage === 0 ? <span className="text-cara-faint">not sent yet</span> : <span className="text-cara-muted">{r.recallStage === 1 ? "WhatsApp sent" : "WhatsApp + SMS sent"}</span>}
                  </td>
                  <td className="text-right"><Link href={`/appointments/plans/${r.plan.id}`} className="tone-link">Open plan</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function RecallPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const user = await requireCapability("appointments.view");
  const viewer = await viewerFor(user);
  const sp = await searchParams;
  const branches = await prisma.branch.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const branchId = viewer.seesAllBranches ? (sp.branch && sp.branch !== "all" ? sp.branch : null) : viewer.homeBranchId;
  const [list, recallOn] = await Promise.all([recallList(branchId), getBoolSetting(RECALL_ENABLED)]);
  const now = new Date();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="cara-eyebrow">Appointments</div>
          <h1 className="cara-title">Recall list</h1>
          <p className="cara-note">Treatment-plan sessions not booked yet. {recallOn ? "Patients get a WhatsApp when a window opens, an SMS at day 3, and a call task at day 7." : "Recall messages are switched off — call from this list."}</p>
        </div>
        <div className="flex items-center gap-3 text-[12.5px]">
          {viewer.seesAllBranches && (
            <span className="flex gap-1.5">
              {[{ id: "all", name: "All" }, ...branches].map((b) => (
                <Link key={b.id} href={`/appointments/recall?branch=${b.id}`} className={`cara-chip ${(branchId ?? "all") === b.id ? "on" : ""}`}>{b.name}</Link>
              ))}
            </span>
          )}
          <Link href="/appointments" className="tone-link">Calendar</Link>
        </div>
      </header>
      <Section title="Overdue" rows={list.overdue} tone="tangerine" now={now} />
      <Section title="Due this week" rows={list.thisWeek} tone="citric" now={now} />
      <Section title="Due in the next 30 days" rows={list.later} tone="ink" now={now} />
    </div>
  );
}
