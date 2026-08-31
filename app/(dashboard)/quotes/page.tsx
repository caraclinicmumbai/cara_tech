import Link from "next/link";
import { requireCapability, leadWhereForUser, quoteWhereForUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  getOpenQuotes,
  getConvertedQuotes,
  STALE_AFTER_DAYS,
  EXPIRING_WITHIN_DAYS,
  type OpenQuoteRow,
} from "@/lib/openQuotes";
import { QUOTE_SOURCE_LABELS, type QuoteSource } from "@/lib/quoteStages";
import { stageLabel } from "@/lib/leadStages";
import { formatIst, formatIstDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The Open Quotes desk (§multi-quote). Every quote still in play, in one table: what
// it's worth (base → discount → GST → payable), who owns it, when it was raised, when
// it lapses, and — expandable per row — the audited trail of what has actually been
// DONE on it. Read-only by design: a quote is edited on its lead, where the rest of
// the person's context is. Route-guarded to `quotes.view`.
//
// No client JS: the filters are links and the activity trail is a native <details>.

function inr(n: number | null): string {
  return n == null ? "—" : `₹${n.toLocaleString("en-IN")}`;
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={`cara-pill${active ? " on" : ""}`}>
      {children}
    </Link>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "danger" | "warning";
}) {
  const toneCls =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-cara-ink";
  return (
    <div className="cara-card px-4 py-3">
      <div className="cara-eyebrow">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="cara-note mt-0.5 text-[11px]">{hint}</div>}
    </div>
  );
}

/// The discount actually applied, shown as it was entered (12.5% / flat ₹) alongside
/// the rupees it took off — the two numbers a manager compares across quotes.
function discountCell(r: OpenQuoteRow) {
  if (!r.discountAmount) return <span className="text-cara-faint">—</span>;
  const entered =
    r.discountType === "percent" ? `${r.discountValue}%` : inr(r.discountValue ?? 0);
  return (
    <span className="text-warning">
      −{inr(r.discountAmount)}
      <span className="text-cara-faint"> ({entered})</span>
    </span>
  );
}

function expiryCell(r: OpenQuoteRow) {
  if (!r.expiresAt) return <span className="text-cara-faint">no expiry</span>;
  const when = formatIstDate(r.expiresAt);
  if (r.expired) {
    return (
      <span className="cara-badge cara-badge-danger" title={when}>
        expired {Math.abs(r.daysToExpiry ?? 0)}d ago
      </span>
    );
  }
  if (r.expiringSoon) {
    return (
      <span className="cara-badge cara-badge-warning" title={when}>
        {r.daysToExpiry}d left
      </span>
    );
  }
  return <span className="text-cara-muted">{when}</span>;
}

export default async function OpenQuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireCapability("quotes.view");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : null);
  const status = str("status");
  const owner = str("owner");
  const branchId = str("branch");
  const stale = sp.stale === "1";
  const expiring = sp.expiring === "1";
  const unassigned = sp.unassigned === "1";

  // §multi-quote — the desk is a personal work list for a counsellor: her quotes, not
  // every quote on a patient she happens to own. Managers get the whole board.
  //
  // For an own-scope counsellor the ownership rule ALREADY carries the lead scope in
  // one OR (see quoteWhereForUser), so the lead filter is not applied a second time —
  // AND'ing it back on would drop the quotes she owns on colleagues' leads.
  const quoteWhere = quoteWhereForUser(user);
  const leadWhere = quoteWhere ? undefined : leadWhereForUser(user);

  const [board, converted, branches] = await Promise.all([
    getOpenQuotes({
      leadWhere,
      quoteWhere,
      status,
      ownerRepId: owner,
      branchId,
      onlyStale: stale,
      onlyExpiring: expiring,
      onlyUnassigned: unassigned,
    }),
    // The won side of the desk. Scope and branch follow the page; the pipeline
    // pills (stale / expiring / status) are meaningless for a settled quote, so
    // they don't narrow this list.
    getConvertedQuotes({ leadWhere, quoteWhere, branchId }),
    prisma.branch.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  // Preserve the other filters when toggling one.
  const qs = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const base: Record<string, string | null> = {
      status,
      owner,
      branch: branchId,
      stale: stale ? "1" : null,
      expiring: expiring ? "1" : null,
      unassigned: unassigned ? "1" : null,
      ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `/quotes?${s}` : "/quotes";
  };

  const { summary } = board;
  const anyFilter = !!(status || owner || branchId || stale || expiring || unassigned);
  const shownValue = board.rows.reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="cara-eyebrow">Pipeline</div>
        <h1 className="cara-title">Open quotes</h1>
        <p className="cara-note">
          Every quote still in play — drafted through awaiting payment. Rejected and
          expired quotes drop off; the ones that closed are listed under{" "}
          <a href="#converted" className="underline">
            Converted quotes
          </a>{" "}
          below, and continue on{" "}
          <Link href="/post-sales" className="underline">
            Post-Sales
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Open quotes" value={String(summary.count)} hint="in your scope" />
        <Tile label="Pipeline value" value={inr(summary.value)} hint="total payable, incl. GST" />
        <Tile
          label="Gone quiet"
          value={String(summary.stale)}
          hint={`no activity in ${STALE_AFTER_DAYS}d`}
          tone={summary.stale > 0 ? "warning" : undefined}
        />
        <Tile
          label="Lapsing"
          value={String(summary.expiringSoon + summary.expired)}
          hint={`expired or within ${EXPIRING_WITHIN_DAYS}d`}
          tone={summary.expired > 0 ? "danger" : summary.expiringSoon > 0 ? "warning" : undefined}
        />
        <Tile
          label="Unassigned"
          value={String(summary.unassigned)}
          hint="no counsellor on the quote"
          tone={summary.unassigned > 0 ? "warning" : undefined}
        />
      </div>

      {/* Status split — the shape of the pipeline, and a filter in its own right. */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill href={qs({ status: null })} active={!status}>
          All statuses ({summary.count})
        </FilterPill>
        {summary.byStatus.map((s) => (
          <FilterPill key={s.status} href={qs({ status: s.status })} active={status === s.status}>
            {s.label} ({s.count}) · {inr(s.value)}
          </FilterPill>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill href={qs({ stale: stale ? null : "1" })} active={stale}>
          Gone quiet
        </FilterPill>
        <FilterPill href={qs({ expiring: expiring ? null : "1" })} active={expiring}>
          Lapsing
        </FilterPill>
        <FilterPill href={qs({ unassigned: unassigned ? null : "1" })} active={unassigned}>
          Unassigned
        </FilterPill>
        {board.owners.length > 0 && (
          <>
            <span className="cara-note ml-2">Owner:</span>
            <FilterPill href={qs({ owner: null })} active={!owner}>
              All
            </FilterPill>
            {board.owners.map((o) => (
              <FilterPill key={o.id} href={qs({ owner: o.id })} active={owner === o.id}>
                {o.name} ({o.count})
              </FilterPill>
            ))}
          </>
        )}
        {branches.length > 1 && (
          <>
            <span className="cara-note ml-2">Branch:</span>
            <FilterPill href={qs({ branch: null })} active={!branchId}>
              All
            </FilterPill>
            {branches.map((b) => (
              <FilterPill key={b.id} href={qs({ branch: b.id })} active={branchId === b.id}>
                {b.name}
              </FilterPill>
            ))}
          </>
        )}
      </div>

      {board.rows.length === 0 ? (
        <p className="cara-card px-4 py-8 text-center text-sm text-cara-muted">
          {anyFilter
            ? "No open quotes match these filters."
            : "No open quotes. One appears here the moment a counsellor raises a quote on a lead."}
        </p>
      ) : (
        <div className="space-y-2">
          {/* The tiles count the whole scope; this counts the slice on screen. */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="cara-note">
              Showing {board.rows.length} of {board.scopedCount} · {inr(shownValue)} of{" "}
              {inr(board.scopedValue)}
            </span>
            {anyFilter && (
              <Link href="/quotes" className="text-[13px] underline">
                Clear filters
              </Link>
            )}
          </div>
          <div className="cara-card overflow-x-auto">
          <table className="cara-table">
            <thead>
              <tr>
                <th className="text-left">Patient / treatment</th>
                <th className="text-left">Status</th>
                <th className="text-left">Owner</th>
                <th className="text-right">Base</th>
                <th className="text-right">Discount</th>
                <th className="text-right">GST</th>
                <th className="text-right">Payable</th>
                <th className="text-left">Raised</th>
                <th className="text-left">Expires</th>
                <th className="text-left">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/leads/${r.leadId}`} className="font-medium hover:underline">
                      {r.patientName}
                    </Link>
                    <div className="text-[12px] text-cara-muted">
                      {r.treatment}
                      {r.cycle > 1 && ` · session ${r.cycle}`}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-cara-faint">
                      <span>{stageLabel(r.leadStage)}</span>
                      {r.source && (
                        <span>· {QUOTE_SOURCE_LABELS[r.source as QuoteSource] ?? r.source}</span>
                      )}
                      {r.branchName && <span>· {r.branchName}</span>}
                      <a
                        href={`/api/quotes/${r.id}/pdf`}
                        target="_blank"
                        rel="noopener"
                        className="underline"
                      >
                        · PDF
                      </a>
                    </div>
                  </td>
                  <td>
                    <span className="cara-badge">{r.statusLabel}</span>
                    {r.revisions > 0 && (
                      <div
                        className="mt-1 text-[11px] text-cara-faint"
                        title={r.lastRevisionNote ?? undefined}
                      >
                        {r.revisions} revision{r.revisions === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.ownerName ?? (
                      <span className="cara-badge cara-badge-warning">Unassigned</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{inr(r.base)}</td>
                  <td className="text-right tabular-nums">{discountCell(r)}</td>
                  <td className="text-right tabular-nums text-cara-muted">
                    {inr(r.gstAmount)}
                    <div className="text-[11px] text-cara-faint">{r.gstRate}%</div>
                  </td>
                  <td className="text-right font-semibold tabular-nums">{inr(r.total)}</td>
                  <td className="whitespace-nowrap">
                    <span title={formatIst(r.createdAt)}>{formatIstDate(r.createdAt)}</span>
                    <div className="text-[11px] text-cara-faint">{r.ageDays}d old</div>
                  </td>
                  <td className="whitespace-nowrap">{expiryCell(r)}</td>
                  <td>
                    {r.activity.length === 0 ? (
                      <span className="text-cara-faint">nothing since it was raised</span>
                    ) : (
                      // Native <details> — the whole trail without a line of client JS.
                      <details className="min-w-45">
                        <summary className="cursor-pointer">
                          <span className={r.stale ? "text-warning" : ""}>
                            {r.activity[0].label} · {r.daysSinceActivity}d ago
                          </span>
                          <div className="text-[11px] text-cara-faint">
                            {r.activity.length} action{r.activity.length === 1 ? "" : "s"} — show
                          </div>
                        </summary>
                        <ul className="mt-2 space-y-1.5 border-l border-cara-rule pl-3">
                          {r.activity.map((a, i) => (
                            <li key={`${a.at}-${i}`} className="text-[11px] leading-snug">
                              <div className="text-cara-ink">
                                {a.label}
                                {a.detail && (
                                  <span className="text-cara-muted"> — {a.detail}</span>
                                )}
                              </div>
                              <div className="text-cara-faint">
                                {formatIst(a.at)}
                                {a.actor && ` · ${a.actor}`}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Converted ─────────────────────────────────────────────────
          The won side of the same desk: what actually closed, for how much, and
          how long it took. Settled work, so no chase columns — the pipeline
          filters above don't apply to it (branch scope does). */}
      <div id="converted" className="space-y-3 scroll-mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Converted quotes</h2>
            <p className="cara-note">
              Accepted and paid for — these have left the pipeline above and continue on{" "}
              <Link href="/post-sales" className="underline">
                Post-Sales
              </Link>
              .
            </p>
          </div>
          <div className="flex gap-3 text-right">
            <div>
              <div className="text-lg font-semibold">{converted.count}</div>
              <div className="cara-note">converted{branchId ? " (this branch)" : ""}</div>
            </div>
            <div>
              <div className="text-lg font-semibold">{inr(converted.value)}</div>
              <div className="cara-note">won, incl. GST</div>
            </div>
            <div>
              <div className="text-lg font-semibold">{inr(converted.recentValue)}</div>
              <div className="cara-note">{converted.recentCount} in the last 30 days</div>
            </div>
          </div>
        </div>

        {converted.rows.length === 0 ? (
          <p className="cara-card px-4 py-6 text-center text-sm text-cara-muted">
            No converted quotes in your scope yet.
          </p>
        ) : (
          <div className="cara-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b-[0.5px] border-cara-rule text-xs uppercase tracking-wide text-cara-muted">
                  <tr>
                    <th className="px-4 py-2">Patient</th>
                    <th className="px-4 py-2">Treatment</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2 text-right">Value</th>
                    <th className="px-4 py-2">Converted</th>
                    <th className="px-4 py-2 text-right">Days to close</th>
                    <th className="px-4 py-2">Counsellor</th>
                    <th className="px-4 py-2">Branch</th>
                  </tr>
                </thead>
                <tbody>
                  {converted.rows.map((r) => (
                    <tr key={r.id} className="border-b-[0.5px] border-cara-rule last:border-0">
                      <td className="px-4 py-2">
                        <Link href={`/leads/${r.leadId}`} className="font-medium hover:underline">
                          {r.patientName}
                        </Link>
                      </td>
                      <td className="px-4 py-2">
                        {r.treatment}
                        {r.cycle > 1 && <span className="text-cara-muted"> · cycle {r.cycle}</span>}
                      </td>
                      <td className="px-4 py-2">
                        <span className="cara-badge">{r.statusLabel}</span>
                      </td>
                      <td className="px-4 py-2 text-right font-medium">{inr(r.total)}</td>
                      <td suppressHydrationWarning className="whitespace-nowrap px-4 py-2">
                        {r.convertedAt ? formatIstDate(r.convertedAt) : "—"}
                      </td>
                      <td className="px-4 py-2 text-right text-cara-muted">
                        {r.daysToClose === null ? "—" : `${r.daysToClose}d`}
                      </td>
                      <td className="px-4 py-2">{r.ownerName ?? "—"}</td>
                      <td className="px-4 py-2 text-cara-muted">
                        {r.branchName ?? "—"}
                        {r.invoicedBranchName && (
                          <span title="Invoiced by a different branch"> · billed {r.invoicedBranchName}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {converted.truncated && (
              <p className="border-t-[0.5px] border-cara-rule px-4 py-2 text-xs text-cara-muted">
                Showing the {converted.rows.length} most recent of {converted.count}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
