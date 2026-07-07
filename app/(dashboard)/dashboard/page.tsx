import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
};

// Pipeline stages in funnel order.
const STATUS_ORDER = ["new", "called", "confirmed", "rescheduled", "lost"];
const OUTCOME_ORDER = ["confirmed", "rescheduled", "no_answer", "not_interested"];
const SENTIMENT_ORDER = ["positive", "neutral", "negative"];

function countMap(
  rows: { _count: { _all: number } }[],
  key: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = (r as Record<string, unknown>)[key];
    out[k == null ? "—" : String(k)] = r._count._all;
  }
  return out;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="text-xs uppercase tracking-wide text-black/40 dark:text-white/40">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && (
        <div className="mt-0.5 text-xs text-black/45 dark:text-white/45">{sub}</div>
      )}
    </div>
  );
}

function BarList({
  items,
}: {
  items: { label: string; value: number }[];
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2">
      {items.map((i) => (
        <div key={i.label} className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="capitalize">{i.label.replace(/_/g, " ")}</span>
            <span className="tabular-nums text-black/60 dark:text-white/60">
              {i.value}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
            <div
              className="h-full rounded-full bg-foreground/80"
              style={{ width: `${(i.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-sm text-black/40 dark:text-white/40">No data yet.</p>
      )}
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-black/10 p-5 dark:border-white/15">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default async function DashboardPage() {
  const [
    totalLeads,
    totalCalls,
    byStatus,
    bySource,
    byOutcome,
    bySentiment,
    durationAgg,
    recentCalls,
  ] = await Promise.all([
    prisma.lead.count(),
    prisma.call.count(),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["source"], _count: { _all: true } }),
    prisma.call.groupBy({ by: ["outcome"], _count: { _all: true } }),
    prisma.call.groupBy({ by: ["sentiment"], _count: { _all: true } }),
    prisma.call.aggregate({ _avg: { duration: true } }),
    prisma.call.findMany({
      orderBy: { createdAt: "desc" },
      include: { lead: true },
      take: 6,
    }),
  ]);

  const statusCounts = countMap(byStatus, "status");
  const outcomeCounts = countMap(byOutcome, "outcome");

  const confirmed = statusCounts["confirmed"] ?? 0;
  const conversionRate = totalLeads ? (confirmed / totalLeads) * 100 : 0;
  const avgDuration = Math.round(durationAgg._avg.duration ?? 0);
  const noAnswer = outcomeCounts["no_answer"] ?? 0;
  const reachRate = totalCalls ? ((totalCalls - noAnswer) / totalCalls) * 100 : 0;

  // Ordered chart series (known buckets first, then any extras).
  const pipeline = STATUS_ORDER.filter((s) => s in statusCounts).map((s) => ({
    label: s,
    value: statusCounts[s],
  }));
  const sources = Object.entries(countMap(bySource, "source"))
    .map(([label, value]) => ({
      label: SOURCE_LABELS[label] ?? label,
      value,
    }))
    .sort((a, b) => b.value - a.value);
  const outcomes = OUTCOME_ORDER.filter((o) => o in outcomeCounts).map((o) => ({
    label: o,
    value: outcomeCounts[o],
  }));
  const sentimentCounts = countMap(bySentiment, "sentiment");
  const sentiments = SENTIMENT_ORDER.filter((s) => s in sentimentCounts).map(
    (s) => ({ label: s, value: sentimentCounts[s] }),
  );

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Total leads" value={totalLeads} />
        <StatCard label="Calls made" value={totalCalls} />
        <StatCard
          label="Confirmed"
          value={confirmed}
          sub={`${conversionRate.toFixed(0)}% of leads`}
        />
        <StatCard label="Reach rate" value={`${reachRate.toFixed(0)}%`} sub="calls answered" />
        <StatCard
          label="Avg call"
          value={avgDuration ? `${avgDuration}s` : "—"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Lead pipeline">
          <BarList items={pipeline} />
        </Panel>
        <Panel title="Leads by source">
          <BarList items={sources} />
        </Panel>
        <Panel title="Call outcomes">
          <BarList items={outcomes} />
        </Panel>
        <Panel title="Call sentiment">
          <BarList items={sentiments} />
        </Panel>
      </div>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Recent calls</h2>
        <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/15">
          <table className="w-full text-sm">
            <thead className="bg-black/5 text-left dark:bg-white/10">
              <tr>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Sentiment</th>
                <th className="px-3 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {recentCalls.map((call) => (
                <tr
                  key={call.id}
                  className="border-t border-black/5 dark:border-white/10"
                >
                  <td className="px-3 py-2">
                    <Link
                      href={`/leads/${call.leadId}`}
                      className="font-medium hover:underline"
                    >
                      {call.lead.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{call.callType}</td>
                  <td className="px-3 py-2">{call.outcome ?? "—"}</td>
                  <td className="px-3 py-2">{call.sentiment ?? "—"}</td>
                  <td className="px-3 py-2 text-black/60 dark:text-white/60">
                    {formatIst(call.createdAt)}
                  </td>
                </tr>
              ))}
              {recentCalls.length === 0 && (
                <tr>
                  <td
                    className="px-3 py-6 text-center text-black/50"
                    colSpan={5}
                  >
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
