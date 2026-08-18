import Link from "next/link";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getBoard } from "@/lib/postSales/board";
import { checkInsEnabled } from "@/lib/postSales/checkins";
import { JOURNEY_STAGES, JOURNEY_STAGE_LABELS, JOURNEY_STAGE_HINTS } from "@/lib/postSales/stages";
import { formatIstDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// The post-sales board (§post-sales). One card per CONVERTED QUOTE — never per patient
// — because a patient who converted a hair transplant and a PRP course has two journeys
// running at their own speeds. Columns are the six clinical stages.
//
// Route-guarded to `postsales.view`. Sales counsellors reach this page read-only: moving
// a stage needs `postsales.manage`, which they don't hold.

function inr(n: number | null): string {
  return n == null ? "—" : `₹${n.toLocaleString("en-IN")}`;
}

/// Filter pills are plain links, so the board needs no client JS at all.
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

export default async function PostSalesBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireCapability("postsales.view");
  const sp = await searchParams;
  const mine = sp.mine === "1";
  const overdue = sp.overdue === "1";
  const closed = sp.closed === "1";
  const branchId = typeof sp.branch === "string" && sp.branch ? sp.branch : null;

  const [board, branches] = await Promise.all([
    getBoard({
      mineUserId: mine ? (user.id ?? null) : null,
      branchId,
      onlyOverdue: overdue,
      includeClosed: closed,
    }),
    prisma.branch.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const canManage = can(user.role, "postsales.manage");
  const canPolicy = can(user.role, "postsales.policy");
  const automationOn = checkInsEnabled();

  // Preserve the other filters when toggling one.
  const qs = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const base: Record<string, string | null> = {
      mine: mine ? "1" : null,
      overdue: overdue ? "1" : null,
      closed: closed ? "1" : null,
      branch: branchId,
      ...patch,
    };
    for (const [k, v] of Object.entries(base)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `/post-sales?${s}` : "/post-sales";
  };

  const columns = closed ? JOURNEY_STAGES : JOURNEY_STAGES.filter((s) => s !== "closed_successfully");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="cara-eyebrow">Post-Sales ERP</div>
          <h1 className="cara-title">Patient journeys</h1>
          <p className="cara-note">
            One journey per converted treatment. {board.total} live
            {board.overdue > 0 && <> · <span className="text-danger">{board.overdue} overdue</span></>}
            {board.blockedCheckIns > 0 && (
              <> · <span className="text-warning">{board.blockedCheckIns} check-in(s) need a person</span></>
            )}
            {board.patientsWithMultiple > 0 && <> · {board.patientsWithMultiple} patient(s) with more than one journey</>}
          </p>
        </div>
        {canPolicy && (
          <Link href="/post-sales/policies" className="cara-btn">
            Stage time limits
          </Link>
        )}
      </div>

      {!canManage && (
        <div className="cara-callout cara-callout-info">
          You have read-only access. The post-sales team owns these stages — ask them to move one.
        </div>
      )}

      {!automationOn && (
        <div className="cara-callout cara-callout-warning">
          Automated care check-ins are switched off (<code>POSTSALES_CHECKINS_ENABLED</code> is not{" "}
          <code>true</code>). Schedules are still generated and shown, but nothing sends — check in by hand and mark
          each one done.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill href={qs({ mine: mine ? null : "1" })} active={mine}>
          My patients
        </FilterPill>
        <FilterPill href={qs({ overdue: overdue ? null : "1" })} active={overdue}>
          Overdue only
        </FilterPill>
        <FilterPill href={qs({ closed: closed ? null : "1" })} active={closed}>
          Include closed
        </FilterPill>
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

      {board.total === 0 ? (
        <p className="cara-card px-4 py-8 text-center text-sm text-cara-muted">
          No {overdue ? "overdue " : ""}journeys{mine ? " assigned to you" : ""}. A journey opens automatically the
          moment a quote converts.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {columns.map((stage) => {
            const col = board.columns.find((c) => c.stage === stage);
            const cards = col?.cards ?? [];
            return (
              <section key={stage} className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="cara-sec-hd">{JOURNEY_STAGE_LABELS[stage]}</h2>
                  <span className="cara-badge">{cards.length}</span>
                </div>
                <p className="cara-note text-[11px] leading-snug">{JOURNEY_STAGE_HINTS[stage]}</p>

                {cards.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-cara-rule px-3 py-5 text-center text-[12px] text-cara-faint">
                    Nothing here
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {cards.map((c) => (
                      <li key={c.id}>
                        <Link href={`/post-sales/${c.id}`} className="cara-card cara-card-hover block space-y-2 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-semibold text-cara-ink">{c.patientName}</div>
                              <div className="truncate text-[12px] text-cara-muted">
                                {c.procedure}
                                {c.cycle > 1 && ` · session ${c.cycle}`}
                              </div>
                            </div>
                            {c.overdue && (
                              <span className="cara-badge cara-badge-danger shrink-0">
                                {c.daysOverdue > 0 ? `${c.daysOverdue}d over` : "overdue"}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap gap-1">
                            {c.flagged && <span className="cara-badge cara-badge-danger">⚠ safety flag</span>}
                            {c.blockedCheckIns > 0 && (
                              <span className="cara-badge cara-badge-warning">
                                {c.blockedCheckIns} check-in{c.blockedCheckIns === 1 ? "" : "s"} need a person
                              </span>
                            )}
                            {c.siblingJourneys > 0 && (
                              <span className="cara-badge cara-badge-info">
                                +{c.siblingJourneys} other journey{c.siblingJourneys === 1 ? "" : "s"}
                              </span>
                            )}
                            {c.openCheckIns > 0 && <span className="cara-badge">{c.openCheckIns} check-in(s) due</span>}
                          </div>

                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cara-faint">
                            <span>{c.daysInStage}d in stage</span>
                            {c.surgeryAt && <span>surgery {formatIstDate(c.surgeryAt)}</span>}
                            <span>{inr(c.totalPayable)}</span>
                            {c.branchName && <span>{c.branchName}</span>}
                            <span>{c.consultantName ?? c.doctorName ?? "unassigned"}</span>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
