import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DIMENSIONS: { key: string; label: string }[] = [
  { key: "intent_clarity", label: "Intent Clarity" },
  { key: "engagement_level", label: "Engagement" },
  { key: "urgency_signal", label: "Urgency" },
  { key: "objection", label: "Objection" },
  { key: "consent_compliance", label: "Consent & Compliance" },
  { key: "escalation", label: "Escalation" },
];

const SOURCE_LABELS: Record<string, string> = {
  web_form: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  referral: "Referral",
  manual: "Manual",
  walk_in: "Walk-in",
  whatsapp: "WhatsApp",
};

function tone(cqs: number): string {
  return cqs >= 75
    ? "text-green-700 dark:text-green-400"
    : cqs >= 50
      ? "text-amber-700 dark:text-amber-400"
      : "text-red-700 dark:text-red-400";
}

function avg(nums: number[]): number {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

export default async function CqsPage() {
  const scored = await prisma.call.findMany({
    where: { cqs: { not: null } },
    select: {
      id: true,
      cqs: true,
      callType: true,
      createdAt: true,
      cqsBreakdown: true,
      lead: { select: { id: true, name: true, source: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const cqsValues = scored.map((c) => c.cqs as number);
  const overall = avg(cqsValues);
  const high = cqsValues.filter((v) => v >= 75).length;
  const medium = cqsValues.filter((v) => v >= 50 && v < 75).length;
  const low = cqsValues.filter((v) => v < 50).length;

  // By source
  const bySource = new Map<string, number[]>();
  for (const c of scored) {
    const s = c.lead?.source ?? "unknown";
    (bySource.get(s) ?? bySource.set(s, []).get(s)!).push(c.cqs as number);
  }
  // By call type
  const byType = new Map<string, number[]>();
  for (const c of scored) {
    (byType.get(c.callType) ?? byType.set(c.callType, []).get(c.callType)!).push(c.cqs as number);
  }
  // By dimension (from breakdown)
  const byDim = DIMENSIONS.map((d) => {
    const vals = scored
      .map((c) => (c.cqsBreakdown as Record<string, unknown> | null)?.[d.key])
      .filter((v): v is number => typeof v === "number");
    return { ...d, avg: avg(vals) };
  });

  const reviewQueue = scored.filter((c) => (c.cqs as number) < 50).slice(0, 20);

  if (scored.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Conversation Quality Score</h1>
        <p className="rounded border border-black/10 px-3 py-8 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
          No scored calls yet. Once calls are scored (set <code>ANTHROPIC_API_KEY</code>), CQS analytics appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Conversation Quality Score</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card label="Scored calls" value={String(scored.length)} />
        <Card label="Average CQS" value={`${overall}`} valueClass={tone(overall)} />
        <Card label="High (≥75)" value={`${high}`} valueClass="text-green-700 dark:text-green-400" />
        <Card label="Low (<50)" value={`${low}`} valueClass="text-red-700 dark:text-red-400" />
      </div>

      {/* Distribution bar */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-black/60 dark:text-white/60">Distribution</h2>
        <div className="flex h-6 overflow-hidden rounded">
          <Seg n={high} total={scored.length} cls="bg-green-600/60" title={`High ${high}`} />
          <Seg n={medium} total={scored.length} cls="bg-amber-500/60" title={`Medium ${medium}`} />
          <Seg n={low} total={scored.length} cls="bg-red-500/60" title={`Low ${low}`} />
        </div>
        <div className="flex gap-4 text-xs text-black/50 dark:text-white/50">
          <span>🟩 High {high}</span>
          <span>🟨 Medium {medium}</span>
          <span>🟥 Low {low}</span>
        </div>
      </section>

      <div className="grid gap-8 md:grid-cols-2">
        {/* By source */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">By source</h2>
          <Breakdown
            rows={[...bySource.entries()]
              .map(([k, v]) => ({ label: SOURCE_LABELS[k] ?? k, avg: avg(v), count: v.length }))
              .sort((a, b) => b.avg - a.avg)}
          />
        </section>

        {/* By call type */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">By call type</h2>
          <Breakdown
            rows={[...byType.entries()]
              .map(([k, v]) => ({ label: k, avg: avg(v), count: v.length }))
              .sort((a, b) => b.avg - a.avg)}
          />
        </section>
      </div>

      {/* By dimension */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">By dimension (average)</h2>
        <div className="space-y-2">
          {byDim.map((d) => (
            <div key={d.key} className="flex items-center gap-3 text-sm">
              <span className="w-44 shrink-0 text-black/60 dark:text-white/60">{d.label}</span>
              <div className="h-3 flex-1 overflow-hidden rounded bg-black/5 dark:bg-white/10">
                <div className={`h-full ${d.avg >= 75 ? "bg-green-600/60" : d.avg >= 50 ? "bg-amber-500/60" : "bg-red-500/60"}`} style={{ width: `${d.avg}%` }} />
              </div>
              <span className={`w-10 shrink-0 text-right tabular-nums ${tone(d.avg)}`}>{d.avg}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Review queue */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Needs review — low CQS ({reviewQueue.length})</h2>
        {reviewQueue.length === 0 ? (
          <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
            No low-scoring calls. 🎉
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
            <table className="min-w-full text-sm">
              <thead className="bg-black/5 text-left dark:bg-white/10">
                <tr>
                  <th className="px-4 py-2 whitespace-nowrap">Lead</th>
                  <th className="px-4 py-2 whitespace-nowrap">CQS</th>
                  <th className="px-4 py-2 whitespace-nowrap">Type</th>
                  <th className="px-4 py-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {reviewQueue.map((c) => (
                  <tr key={c.id} className="border-t border-black/5 dark:border-white/10">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <Link href={`/leads/${c.lead?.id}`} className="font-medium hover:underline">
                        {c.lead?.name ?? "—"}
                      </Link>
                    </td>
                    <td className={`px-4 py-2 whitespace-nowrap font-medium ${tone(c.cqs as number)}`}>{c.cqs}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{c.callType}</td>
                    <td className="max-w-md px-4 py-2 text-black/70 dark:text-white/70">
                      {(c.cqsBreakdown as Record<string, unknown> | null)?.summary as string | undefined}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Card({ label, value, valueClass = "" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded border border-black/10 p-4 dark:border-white/15">
      <div className="text-xs uppercase tracking-wide text-black/40 dark:text-white/40">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function Seg({ n, total, cls, title }: { n: number; total: number; cls: string; title: string }) {
  if (n === 0) return null;
  return <div className={cls} style={{ width: `${(n / total) * 100}%` }} title={title} />;
}

function Breakdown({ rows }: { rows: { label: string; avg: number; count: number }[] }) {
  return (
    <div className="overflow-hidden rounded border border-black/10 dark:border-white/15">
      <table className="min-w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-black/5 first:border-t-0 dark:border-white/10">
              <td className="px-4 py-2">{r.label}</td>
              <td className="px-4 py-2 text-right text-black/50 dark:text-white/50">{r.count}</td>
              <td className={`w-12 px-4 py-2 text-right font-medium tabular-nums ${tone(r.avg)}`}>{r.avg}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
