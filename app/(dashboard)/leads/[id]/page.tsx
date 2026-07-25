import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StageSelect } from "@/components/StageSelect";
import { TagField } from "@/components/TagField";
import { WhatsAppChat } from "@/components/WhatsAppChat";
import { CallButton } from "@/components/CallButton";
import { MergeLeadButton } from "@/components/MergeLeadButton";
import { QuotesPanel } from "@/components/QuotesPanel";
import { isServiceWindowOpen } from "@/lib/messages";
import { formatIst } from "@/lib/datetime";
import { currentUser, canSeeLead } from "@/lib/authz";
import { can, leadScope } from "@/lib/rbac";
import { summariseQuotes } from "@/lib/quotes";
import { listCatalogGroups } from "@/lib/catalog";
import { readLeadTimeline } from "@/lib/audit";
import { listActiveGrants } from "@/lib/leadOwnership";
import { LeadOwnershipPanel } from "@/components/LeadOwnershipPanel";

export const dynamic = "force-dynamic";

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

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
      {children}
    </span>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-black/40 dark:text-white/40">
        {label}
      </dt>
      <dd className="text-sm">{value || "—"}</dd>
    </div>
  );
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      calls: { orderBy: { createdAt: "desc" }, include: { handledBy: { select: { name: true } } } },
      duplicateOf: true,
      duplicates: { orderBy: { createdAt: "desc" } },
      messages: { orderBy: { createdAt: "asc" } },
      assignedRep: true,
      quotes: { orderBy: { createdAt: "desc" }, include: { ownerRep: { select: { name: true } } } },
      // Active grants — makes the ownership scope check (canSeeLead) honour a covering
      // colleague, and feeds the ownership panel.
      accessGrants: { where: { revokedAt: null }, select: { granteeId: true, revokedAt: true, expiresAt: true } },
    },
  });

  if (!lead) notFound();

  // Ownership scope (§3.1 RBAC): front-desk/telecaller may only open their own
  // leads. Treat others as not found rather than leaking the record's existence.
  const viewer = await currentUser();
  if (!viewer || !canSeeLead(viewer, lead)) notFound();

  const windowOpen = await isServiceWindowOpen(lead.id);
  const canViewQuotes = can(viewer.role, "quotes.view");
  const canManageQuotes = can(viewer.role, "quotes.manage");
  const quoteSummary = summariseQuotes(lead.quotes);
  // Assignable owners for the per-quote owner picker (active, non-sales-head reps).
  const quoteReps = canManageQuotes
    ? await prisma.salesRep.findMany({
        where: { active: true, salesHead: false },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];
  // Treatment catalog for the quote picker (Services + Packages, grouped by category).
  const catalog = canManageQuotes ? await listCatalogGroups() : [];

  // ── Ownership & access (§handover) ──
  const isManagerScope = leadScope(viewer.role) === "all";
  const canHandover = can(viewer.role, "leads.handover") && (isManagerScope || viewer.salesRepId === lead.assignedRepId);
  const canGrant = can(viewer.role, "leads.grantAccess");
  const [handoverReps, granteeUsers, activeGrants, ownershipHistory] = await Promise.all([
    canHandover
      ? prisma.salesRep.findMany({
          where: { active: true, salesHead: false },
          select: { id: true, name: true, branchId: true, branch: { select: { name: true } } },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    canGrant
      ? prisma.user.findMany({
          where: { role: { in: ["front_desk", "telecaller", "branch_manager", "sales_head"] } },
          select: { id: true, name: true, email: true },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    listActiveGrants(lead.id),
    readLeadTimeline(lead.id),
  ]);
  const ownershipReps = handoverReps.map((r) => ({ id: r.id, name: r.name, branchId: r.branchId, branchName: r.branch?.name ?? null }));
  const granteeOptions = granteeUsers
    .filter((u) => u.id !== viewer.id)
    .map((u) => ({ id: u.id, label: u.name ? `${u.name} (${u.email})` : u.email }));

  return (
    <div className="space-y-8">
      <div>
        <Link href="/leads" className="text-sm text-black/50 hover:underline dark:text-white/50">
          ← Leads
        </Link>
      </div>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{lead.name}</h1>
          <Pill>{lead.status}</Pill>
          <StageSelect leadId={lead.id} stage={lead.stage} />
          {canViewQuotes && lead.quotes.length > 0 && (
            <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
              {quoteSummary.label}
            </span>
          )}
        </div>

        {lead.optedOut && (
          <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
            🚫 <span className="font-medium">Opted out — all outreach suppressed.</span>
            {lead.optedOutReason ? ` ${lead.optedOutReason}.` : ""}
            {lead.optedOutAt ? ` (${formatIst(lead.optedOutAt)})` : ""}
          </div>
        )}

        {lead.needsHandover && (
          <div className="rounded border border-purple-500/50 bg-purple-500/10 px-3 py-2 text-sm">
            🤝 <span className="font-medium">Handover to sales.</span>
            {lead.handoverReason ? ` ${lead.handoverReason}.` : ""}
            {lead.assignedRep ? ` Assigned to ${lead.assignedRep.name}.` : ""}
            {lead.handoverAt ? ` (${formatIst(lead.handoverAt)})` : ""}
          </div>
        )}

        {/* Manual rep call — available for assigned leads AND opted-out leads (opt-out
            only suppresses AUTOMATED calls, a human rep may still dial back). */}
        {(lead.assignedRep || lead.optedOut) && (
          <div className="space-y-1">
            <CallButton leadId={lead.id} repName={lead.assignedRep?.name} />
            {lead.optedOut && !lead.assignedRep && (
              <p className="text-xs text-black/40 dark:text-white/40">
                Manual call — automated outreach stays suppressed for this opted-out lead.
              </p>
            )}
          </div>
        )}

        {lead.stage === "lost" && (
          <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
            ❌ <span className="font-medium">Marked lost.</span>
            {lead.lostTag ? ` Reason: ${lead.lostTag}.` : ""}
            {lead.lostReason ? ` Review: ${lead.lostReason}.` : ""}
            {lead.lostAt ? ` (${formatIst(lead.lostAt)})` : ""}
          </div>
        )}

        {lead.heldForReview && (
          <div className="rounded border border-orange-500/50 bg-orange-500/10 px-3 py-2 text-sm">
            🛑 <span className="font-medium">Held for review</span> — no AI call was placed.
            {lead.heldReason ? ` ${lead.heldReason}.` : ""}
            {lead.heldAt ? ` (${formatIst(lead.heldAt)})` : ""} Vet this lead before contacting.
          </div>
        )}

        {lead.duplicateOf && (
          <div className="space-y-2 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
            <div>
              ⚠️ <span className="font-medium">Possible duplicate</span> of an existing lead —{" "}
              <Link href={`/leads/${lead.duplicateOf.id}`} className="font-medium underline">
                {lead.duplicateOf.name} ({lead.duplicateOf.phone})
              </Link>
              . No AI call was placed; review/merge before contacting.
            </div>
            <MergeLeadButton leadId={lead.id} originalName={lead.duplicateOf.name} />
          </div>
        )}

        {lead.duplicates.length > 0 && (
          <div className="rounded border border-black/15 bg-black/5 px-3 py-2 text-sm dark:border-white/20 dark:bg-white/5">
            {lead.duplicates.length} later enquir{lead.duplicates.length === 1 ? "y" : "ies"} matched this record:{" "}
            {lead.duplicates.map((d, i) => (
              <span key={d.id}>
                {i > 0 && ", "}
                <Link href={`/leads/${d.id}`} className="underline">
                  {d.name}
                </Link>
              </span>
            ))}
          </div>
        )}

        {lead.callbackAt && (
          <div className="rounded border border-blue-500/40 bg-blue-500/5 px-3 py-2 text-sm">
            📞 <span className="font-medium">Callback requested</span> for{" "}
            {formatIst(lead.callbackAt)} — auto-retries cancelled, a call is scheduled for this time.
          </div>
        )}

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Phone" value={lead.phone} />
          <Field label="Email" value={lead.email} />
          <Field
            label="Source"
            value={lead.source ? (SOURCE_LABELS[lead.source] ?? lead.source) : null}
          />
          <Field label="Interest" value={lead.interest} />
          <Field label="Interest level" value={lead.interestLevel} />
          <Field
            label="Tag (asked for)"
            value={<TagField leadId={lead.id} tag={lead.tag} className="px-0" />}
          />
          <Field label="Campaign" value={lead.campaign} />
          <Field label="Ad ID" value={lead.adId} />
          <Field
            label="Callback at"
            value={lead.callbackAt ? formatIst(lead.callbackAt) : null}
          />
          <Field label="Created" value={formatIst(lead.createdAt)} />
          <Field label="Updated" value={formatIst(lead.updatedAt)} />
        </dl>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Ownership &amp; access</h2>
        <LeadOwnershipPanel
          leadId={lead.id}
          ownerName={lead.assignedRep?.name ?? "Unassigned"}
          ownerRepId={lead.assignedRepId}
          ownerBranchId={lead.assignedRep?.branchId ?? null}
          reps={ownershipReps}
          users={granteeOptions}
          activeGrants={activeGrants}
          history={ownershipHistory}
          canHandover={canHandover}
          canGrant={canGrant}
        />
      </section>

      {canViewQuotes && (
        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Quotes ({lead.quotes.length})</h2>
            <span className="text-sm text-black/50 dark:text-white/50">{quoteSummary.label}</span>
          </div>
          <QuotesPanel
            leadId={lead.id}
            canManage={canManageQuotes}
            windowOpen={windowOpen}
            templateConfigured={!!process.env.QUOTE_DOC_TEMPLATE_NAME}
            reps={quoteReps}
            catalog={catalog}
            quotes={lead.quotes.map((q) => ({
              id: q.id,
              treatment: q.treatment,
              status: q.status,
              cycle: q.cycle,
              price: q.price,
              currency: q.currency,
              gstRate: q.gstRate,
              discountType: q.discountType,
              discountValue: q.discountValue,
              totalPayable: q.totalPayable,
              source: q.source,
              ownerRepId: q.ownerRepId,
              ownerName: q.ownerRep?.name ?? null,
              expiresAt: q.expiresAt?.toISOString() ?? null,
              convertedAt: q.convertedAt?.toISOString() ?? null,
              lockedAt: q.lockedAt?.toISOString() ?? null,
              createdAt: q.createdAt.toISOString(),
            }))}
          />
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">WhatsApp</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              windowOpen
                ? "bg-green-600/15 text-green-700 dark:text-green-400"
                : "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50"
            }`}
          >
            {windowOpen ? "24h window open" : "window closed"}
          </span>
        </div>
        <WhatsAppChat
          leadId={lead.id}
          windowOpen={windowOpen}
          optedOut={lead.optedOut}
          messages={lead.messages.map((m) => ({
            id: m.id,
            direction: m.direction,
            type: m.type,
            body: m.body,
            mediaId: m.mediaId,
            status: m.status,
            sentBy: m.sentBy,
            automated: m.automated,
            createdAt: m.createdAt.toISOString(),
          }))}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Calls ({lead.calls.length})</h2>

        {lead.calls.length === 0 ? (
          <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
            No calls yet for this lead.
          </p>
        ) : (
          <ul className="space-y-3">
            {lead.calls.map((call) => (
              <li
                key={call.id}
                className="rounded border border-black/10 p-4 dark:border-white/15"
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-medium">{call.callType}</span>
                  {call.callType === "human_handover" && (
                    <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                      👤 Handled by {call.handledBy?.name ?? "—"}
                    </span>
                  )}
                  <span>Outcome: {call.outcome ?? "—"}</span>
                  <span>Sentiment: {call.sentiment ?? "—"}</span>
                  <span>Duration: {call.duration ? `${call.duration}s` : "—"}</span>
                  {typeof call.cqs === "number" && (
                    <span
                      title="Conversation Quality Score"
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        call.cqs >= 75
                          ? "bg-green-600/15 text-green-700 dark:text-green-400"
                          : call.cqs >= 50
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : "bg-red-500/15 text-red-700 dark:text-red-400"
                      }`}
                    >
                      CQS {call.cqs}
                    </span>
                  )}
                  <span className="ml-auto text-black/50 dark:text-white/50">
                    {formatIst(call.createdAt)}
                  </span>
                </div>

                {call.recordingUrl && (
                  <audio
                    controls
                    preload="none"
                    className="mt-3 w-full"
                    src={`/api/twilio/recording/${call.id}`}
                  />
                )}

                {/* AI (ElevenLabs) call recording — fetched on demand from ElevenLabs. */}
                {!call.recordingUrl && call.elevenlabsId && (
                  <audio
                    controls
                    preload="none"
                    className="mt-3 w-full"
                    src={`/api/elevenlabs/recording/${call.id}`}
                  />
                )}

                {call.transcript ? (
                  <details className="mt-3 group">
                    <summary className="cursor-pointer text-sm text-black/60 hover:underline dark:text-white/60">
                      Transcript
                    </summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-3 text-xs leading-relaxed dark:bg-white/10">
                      {call.transcript}
                    </pre>
                  </details>
                ) : (
                  <p className="mt-3 text-xs text-black/40 dark:text-white/40">
                    No transcript captured.
                  </p>
                )}

                {call.elevenlabsId && (
                  <p className="mt-2 text-xs text-black/30 dark:text-white/30">
                    ElevenLabs ID: {call.elevenlabsId}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
