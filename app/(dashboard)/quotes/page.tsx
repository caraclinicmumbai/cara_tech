import Link from "next/link";
import { requireCapability, leadWhereForUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  getOpenQuotes,
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

  const [board, branches] = await Promise.all([
    getOpenQuotes({
      leadWhere: leadWhereForUser(user),
      status,
      ownerRepId: owner,
      branchId,
      onlyStale: stale,
      onlyExpiring: expiring,
      onlyUnassigned: unassigned,
    }),
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
          Every quote still in play — drafted through awaiting payment. Converted and
          closed quotes leave this desk; the won ones continue on{" "}
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
    </div>
  );
}
