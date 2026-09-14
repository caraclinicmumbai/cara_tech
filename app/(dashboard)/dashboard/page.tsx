import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/datetime";
import { getDashboardData } from "@/lib/dashboardMetrics";
import { StatTile } from "@/components/dashboard/StatTile";
import { LeadsColumns } from "@/components/dashboard/LeadsColumns";
import { SourceDonut } from "@/components/dashboard/SourceDonut";
import { QueueCard } from "@/components/dashboard/QueueCard";

export const dynamic = "force-dynamic";

/// First name only. "Hello, Dr. Asif Sheikh" reads like a letter from a bank;
/// the greeting is meant to sound like the software knows who just logged in.
function firstName(name?: string | null, email?: string | null): string {
  const from = name?.trim() || email?.split("@")[0] || "there";
  return from.split(/[\s.]+/)[0].replace(/^./, (c) => c.toUpperCase());
}

export default async function DashboardPage() {
  const [session, data, recentCalls] = await Promise.all([
    auth(),
    getDashboardData(),
    prisma.call.findMany({
      orderBy: { createdAt: "desc" },
      include: { lead: true },
      take: 6,
    }),
  ]);

  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <div className="space-y-5">
      {/* Greeting rather than a page title: this screen is the first thing the
          desk sees each morning, and it should open by naming the day. */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-cara-ink">
            Hello, {firstName(session?.user?.name, session?.user?.email)}
            <span aria-hidden> 👋</span>
          </h1>
          <p className="mt-1 text-[13px] text-cara-muted">
            Here&rsquo;s what&rsquo;s happening at the clinic this month.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="cara-chip">{data.monthLabel}</span>
          <span className="cara-chip text-cara-muted">{today}</span>
        </div>
      </header>

      {/* Bento: the five headline figures on the left, the trend beside them. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Five figures in a two-column block: the last one spans, so the grid
            closes instead of leaving an orphan tile beside empty space. */}
        <div className="grid grid-cols-2 gap-4 self-start">
          {data.stats.map((stat, i) => (
            <div key={stat.label} className={i === data.stats.length - 1 ? "col-span-2" : ""}>
              <StatTile stat={stat} featured={i === 0} />
            </div>
          ))}
        </div>

        <section className="cara-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-cara-ink">Leads coming in</h2>
              <p className="mt-0.5 text-[11px] text-cara-faint">Last 8 days · IST</p>
            </div>
            <Link href="/leads" aria-label="Open leads" className="cara-tile-arrow" title="Open leads">
              <span aria-hidden>↗</span>
            </Link>
          </div>
          <div className="mt-5">
            <LeadsColumns data={data.daily} />
          </div>
        </section>
      </div>

      {/* What is waiting on a person, and where the leads came from. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
        <QueueCard
          icon="☎"
          count={data.awaitingFirstCall}
          noun={data.awaitingFirstCall === 1 ? "lead" : "leads"}
          waiting={`${data.awaitingFirstCall} ${data.awaitingFirstCall === 1 ? "lead has" : "leads have"} never been called.`}
          href="/leads"
          linkLabel="Open leads awaiting a first call"
        />
        <QueueCard
          icon="🤝"
          count={data.awaitingHandover}
          noun={data.awaitingHandover === 1 ? "handover" : "handovers"}
          waiting={`${data.awaitingHandover} ${data.awaitingHandover === 1 ? "patient is" : "patients are"} waiting for a counsellor.`}
          href="/leads"
          linkLabel="Open handovers"
        />

        <section className="cara-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-semibold text-cara-ink">Where leads come from</h2>
              <p className="mt-0.5 text-[11px] text-cara-faint">All time, by source</p>
            </div>
            <Link href="/reports" aria-label="Open reports" className="cara-tile-arrow" title="Open reports">
              <span aria-hidden>↗</span>
            </Link>
          </div>
          <div className="mt-5">
            <SourceDonut data={data.sources} />
          </div>
        </section>
      </div>

      <section className="cara-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-cara-ink">Recent calls</h2>
          <Link href="/calls" className="tone-link text-[13px] hover:underline">
            All calls →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="cara-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Type</th>
                <th>Outcome</th>
                <th>Sentiment</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recentCalls.map((call) => (
                <tr key={call.id}>
                  <td>
                    <Link
                      href={`/leads/${call.leadId}`}
                      className="font-medium text-cara-ink hover:underline"
                    >
                      {call.lead.name}
                    </Link>
                  </td>
                  <td className="text-cara-muted">{call.callType}</td>
                  <td className="text-cara-muted">{call.outcome ?? "—"}</td>
                  <td className="text-cara-muted">{call.sentiment ?? "—"}</td>
                  <td className="text-cara-muted">{formatIst(call.createdAt)}</td>
                </tr>
              ))}
              {recentCalls.length === 0 && (
                <tr>
                  <td className="text-center text-cara-faint" colSpan={5}>
                    No calls yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
