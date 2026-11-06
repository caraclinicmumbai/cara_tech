import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/datetime";
import { currentUser, leadWhereForUser } from "@/lib/authz";
import { callOutcomeLabel } from "@/lib/clickToCallLog";
import { callTypeLabel, isInboundCallType } from "@/lib/inboundCallLog";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CallFilters } from "@/components/CallFilters";
import {
  AI_REP,
  CALL_KINDS,
  CALL_KIND_LABELS,
  CALL_STATUSES,
  CALL_STATUS_LABELS,
  CALLS_PAGE_SIZE,
  callListFiltered,
  callListQuery,
  callListWhere,
  parseCallListParams,
} from "@/lib/callList";
import { salesTeamLabel } from "@/lib/salesTeams";

export const dynamic = "force-dynamic";

/// The AI's call types read as raw keys otherwise; the inbound ones have their own tags.
const CALL_TYPE_LABELS: Record<string, string> = {
  initial: "AI call",
  reconfirmation: "AI reconfirmation",
  human_handover: "Counsellor call",
};

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  const filters = parseCallListParams(await searchParams);
  // Scope to the viewer's leads (front-desk/telecaller = own; others = all).
  const where = callListWhere(filters, leadWhereForUser(user!));

  const total = await prisma.call.count({ where });
  const pages = Math.max(1, Math.ceil(total / CALLS_PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const [calls, reps] = await Promise.all([
    prisma.call.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * CALLS_PAGE_SIZE,
      take: CALLS_PAGE_SIZE,
      include: { lead: { select: { name: true } }, handledBy: { select: { name: true } } },
    }),
    // Removed reps stay: their past calls are still in the history.
    prisma.salesRep.findMany({ select: { id: true, name: true, team: true, deletedAt: true }, orderBy: { name: "asc" } }),
  ]);
  const pageHref = (n: number) => {
    const qs = callListQuery({ ...filters, page: n });
    return qs ? `/calls?${qs}` : "/calls";
  };

  return (
    <div className="space-y-4">
      {/* New calls — an IVR Missed above all — appear without a manual refresh. */}
      <AutoRefresh />
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">History</div>
        <h1 className="cara-title">Call history ({total.toLocaleString("en-IN")})</h1>
      </header>
      <CallFilters
        filters={{ ...filters, page }}
        kinds={CALL_KINDS.map((k) => ({ value: k, label: CALL_KIND_LABELS[k] }))}
        statuses={CALL_STATUSES.map((k) => ({ value: k, label: CALL_STATUS_LABELS[k] }))}
        reps={[
          ...reps.map((r) => ({
            value: r.id,
            label: `${r.name} · ${r.deletedAt ? "removed" : salesTeamLabel(r.team)}`,
          })),
          { value: AI_REP, label: "AI / nobody" },
        ]}
      />
      <div className="cara-card overflow-x-auto">
        <table className="cara-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Type</th>
              <th>Handled by</th>
              <th>Outcome</th>
              <th>Sentiment</th>
              <th>Duration</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.id}>
                <td>
                  <Link href={`/leads/${call.leadId}`} className="font-medium text-cara-ink hover:underline">
                    {call.lead.name}
                  </Link>
                </td>
                <td>
                  {isInboundCallType(call.callType) ? (
                    <span
                      className={`tag ${callTypeLabel(call.callType, call.outcome) === "IVR Missed" ? "tag-tangerine" : "tag-aqua"}`}
                    >
                      {callTypeLabel(call.callType, call.outcome)}
                    </span>
                  ) : (
                    (CALL_TYPE_LABELS[call.callType] ?? call.callType)
                  )}
                </td>
                <td>
                  {call.callType === "human_handover" || isInboundCallType(call.callType)
                    ? (call.handledBy?.name ?? "—")
                    : "AI"}
                </td>
                <td>
                  {callOutcomeLabel(call.outcome, call.createdAt)}
                  {/* The voicemail or call recording, played from whichever provider holds it. */}
                  {call.recordingUrl && (
                    <a
                      href={`/api/twilio/recording/${call.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="tone-link ml-2 text-xs hover:underline"
                    >
                      Listen
                    </a>
                  )}
                </td>
                <td>{call.sentiment ?? "—"}</td>
                <td>{call.duration ? `${call.duration}s` : "—"}</td>
                <td className="text-cara-muted">{formatIst(call.createdAt)}</td>
              </tr>
            ))}
            {calls.length === 0 && (
              <tr>
                <td className="text-center text-cara-faint" colSpan={7}>
                  {callListFiltered(filters) ? "No calls match these filters." : "No calls yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="flex items-center justify-end gap-3 text-sm" aria-label="Call history pages">
          {page > 1 && <Link className="tone-link hover:underline" href={pageHref(page - 1)}>‹ Previous</Link>}
          <span className="tabular-nums text-cara-muted">Page {page} of {pages}</span>
          {page < pages && <Link className="tone-link hover:underline" href={pageHref(page + 1)}>Next ›</Link>}
        </nav>
      )}
    </div>
  );
}
