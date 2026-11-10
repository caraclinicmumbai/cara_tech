// Reports 12–15: Telecalling, Speed to Call, Telecaller Activity and Follow-Ups. The same
// sections serve /reports (everyone) and /my-numbers (one person, passed as `repId`).

import Link from "next/link";
import { formatIst } from "@/lib/datetime";
import { permittedWindow } from "@/lib/callWindow";
import {
  BUCKETS,
  BUCKET_LABELS,
  telecallingReport,
  type Bucket,
  type TelecallingCounts,
} from "@/lib/reports/telecalling";
import {
  SPEED_RESULTS,
  SPEED_RESULT_LABELS,
  speedToCall,
  type SpeedResult,
} from "@/lib/reports/speedToCall";
import { telecallerActivity, type ActivityDay } from "@/lib/reports/telecallerActivity";
import { followUpTracking, type FollowUpStatus } from "@/lib/reports/followUpTracking";
import type { DateRange } from "@/lib/reports/range";
import { duration, pct, sourceLabel, talkTime } from "@/lib/reports/shared";
import { salesTeamLabel } from "@/lib/salesTeams";
import { Caveat, Empty, LeadLink, Num, Panel, Table, Tile } from "@/components/ReportUI";

type Href = (extra: Record<string, string>) => string;

const SPEED_PAGE_SIZE = 50;

const istTime = (ms: number | Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(ms);

const istDayLabel = (day: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
    new Date(`${day}T00:00:00Z`),
  );

/// The calls behind a row, on the Calls page.
function callsHref(fromDay: string, toDay: string, repId?: string): string {
  const q = new URLSearchParams({ from: `${fromDay}T00:00`, to: `${toDay}T23:59` });
  if (repId) q.set("rep", repId);
  return `/calls?${q.toString()}`;
}

function CountCells({ c }: { c: TelecallingCounts }) {
  return (
    <>
      <Num>{c.connected}</Num>
      <Num>{c.notConnected}</Num>
      <Num>{pct(c.connectPct)}</Num>
      <Num>{talkTime(c.talkSeconds)}</Num>
      <Num>{talkTime(c.avgSeconds)}</Num>
      <Num>{c.booked}</Num>
      <Num>{c.showed}</Num>
      <Num>{c.noShows}</Num>
      <Num>{pct(c.showPct)}</Num>
    </>
  );
}

const COUNT_HEAD = [
  { label: "Calls", align: "right" },
  { label: "Connected", align: "right" },
  { label: "Not connected", align: "right" },
  { label: "Connect rate", align: "right" },
  { label: "Talk time", align: "right" },
  { label: "Avg call", align: "right" },
  { label: "Booked", align: "right" },
  { label: "Came", align: "right" },
  { label: "No-show", align: "right" },
  { label: "Show rate", align: "right" },
] as const;

// ── 12. Telecalling ──────────────────────────────────────────────────

export async function TelecallingSection({
  range,
  by,
  repId,
  href,
}: {
  range: DateRange;
  by: Bucket;
  repId?: string;
  href: Href;
}) {
  const r = await telecallingReport(range, by, repId);
  const t = r.totals;

  return (
    <div className="space-y-5">
      <Caveat>
        Calls a person handled: click-to-call and answered clinic-line calls. AI calls have their own
        report. <strong className="font-medium">Booked</strong> is dated when the booking was made;{" "}
        <strong className="font-medium">came</strong> and <strong className="font-medium">no-show</strong>{" "}
        by the appointment&rsquo;s date, so a day can show more arrivals than bookings. Only bookings
        made by a telecaller&rsquo;s own login count. Calls dialled from a personal phone aren&rsquo;t
        in the CRM.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Calls" value={t.calls} hint={`${t.outbound} outgoing, ${t.inbound} answered incoming`} />
        <Tile label="Connected" value={pct(t.connectPct)} hint={`${t.connected} connected, ${t.notConnected} not`} />
        <Tile label="Talk time" value={talkTime(t.talkSeconds)} hint={`average call ${talkTime(t.avgSeconds)}`} />
        <Tile label="Show rate" value={pct(t.showPct)} hint={`${t.booked} booked, ${t.showed} came, ${t.noShows} no-show`} />
      </div>

      {r.missedInbound != null && r.missedInbound > 0 && (
        <p className="cara-note text-[12px]">
          {r.missedInbound} clinic-line call{r.missedInbound === 1 ? " was" : "s were"} missed in this range.
          Nobody answered, so they&rsquo;re on no one&rsquo;s row.
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {BUCKETS.map((b) => (
          <Link key={b} href={href({ by: b })} className={`cara-pill${b === by ? " on" : ""}`}>
            {BUCKET_LABELS[b]}
          </Link>
        ))}
      </div>

      <Table head={[{ label: BUCKET_LABELS[by] }, ...COUNT_HEAD]} note="Select a number of calls to see each call, with its duration, on the Calls page.">
        {[...r.buckets].reverse().map((b) => (
          <tr key={b.key}>
            <td className="whitespace-nowrap text-cara-ink">{b.label}</td>
            <Num strong>
              <Link href={callsHref(b.fromDay, b.toDay, repId)} className="hover:underline">
                {b.calls}
              </Link>
            </Num>
            <CountCells c={b} />
          </tr>
        ))}
      </Table>

      {!repId && (
        <Panel title="By person">
          {r.reps.length === 0 ? (
            <Empty>No telecaller activity in this range.</Empty>
          ) : (
            <Table head={["Telecaller", "Team", ...COUNT_HEAD]}>
              {r.reps.map((row) => (
                <tr key={row.repId}>
                  <td className="whitespace-nowrap text-cara-ink">{row.repName}</td>
                  <td className="whitespace-nowrap text-[12px] text-cara-muted">
                    {row.salesHead ? "Sales head" : salesTeamLabel(row.team)}
                  </td>
                  <Num strong>
                    <Link href={callsHref(range.fromDay, range.toDay, row.repId)} className="hover:underline">
                      {row.calls}
                    </Link>
                  </Num>
                  <CountCells c={row} />
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      )}
    </div>
  );
}

// ── 13. Speed to Call ────────────────────────────────────────────────

const RESULT_TONE: Record<SpeedResult, string> = {
  within: "text-[var(--state-success-tx)]",
  late: "text-warning",
  not_called: "text-danger",
  waiting: "text-cara-muted",
};

export async function SpeedSection({
  range,
  repId,
  repFilter,
  result,
  page,
  href,
}: {
  range: DateRange;
  /// One person's own view: only their leads, and no one else's name to filter by.
  repId?: string;
  repFilter?: string;
  result?: SpeedResult;
  page: number;
  href: Href;
}) {
  const r = await speedToCall(range, { repId: repId ?? repFilter });
  const everyone = repFilter ? await speedToCall(range) : r;
  const t = r.totals;

  const listed = result ? r.records.filter((x) => x.result === result) : r.records;
  const pages = Math.max(1, Math.ceil(listed.length / SPEED_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const shown = listed.slice((current - 1) * SPEED_PAGE_SIZE, current * SPEED_PAGE_SIZE);
  const keep = { ...(repFilter ? { rep: repFilter } : {}), ...(result ? { result } : {}) };

  return (
    <div className="space-y-5">
      <Caveat>
        The clock starts when the lead arrives, or at the next opening of the calling window if it
        arrived overnight. It stops at the first call by a person, connected or not; AI calls
        don&rsquo;t stop it. Patients who rang the clinic themselves, walk-ins, merged leads and leads
        from the previous CRM are left out. A lead is credited to whoever called first, or to its
        owner until someone does.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Within 5 minutes"
          value={pct(t.withinPct)}
          hint={`${t.within} of ${t.within + t.late + t.notCalled} leads`}
          tone={t.withinPct == null ? undefined : t.withinPct >= 80 ? "good" : t.withinPct >= 50 ? "warning" : "danger"}
        />
        <Tile label="Median wait" value={duration(t.medianMs)} hint={`average ${duration(t.meanMs)}`} />
        <Tile label="Over 5 minutes" value={t.late} />
        <Tile label="Not called" value={t.notCalled} tone={t.notCalled > 0 ? "danger" : undefined} />
      </div>

      {!repId && (
        <Panel title="By person">
          {everyone.reps.length === 0 ? (
            <Empty>No new leads in this range.</Empty>
          ) : (
            <Table
              head={[
                "Telecaller",
                { label: "Leads", align: "right" },
                { label: "Within 5 min", align: "right" },
                { label: "Rate", align: "right" },
                { label: "Over 5 min", align: "right" },
                { label: "Not called", align: "right" },
                { label: "Median wait", align: "right" },
                { label: "Average wait", align: "right" },
              ]}
            >
              {everyone.reps.map((row) => (
                <tr key={row.repId ?? "none"}>
                  <td className="whitespace-nowrap text-cara-ink">
                    {row.repId ? (
                      <Link href={href({ rep: row.repId })} className="hover:underline">
                        {row.repName}
                      </Link>
                    ) : (
                      row.repName
                    )}
                  </td>
                  <Num>{row.leads}</Num>
                  <Num>{row.within}</Num>
                  <Num strong>{pct(row.withinPct)}</Num>
                  <Num>{row.late}</Num>
                  <Num>{row.notCalled}</Num>
                  <Num>{duration(row.medianMs)}</Num>
                  <Num>{duration(row.meanMs)}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      )}

      <Panel title="Lead by lead" hint="Newest first.">
        <div className="flex flex-wrap gap-1.5">
          <Link href={href(repFilter ? { rep: repFilter } : {})} className={`cara-pill${!result ? " on" : ""}`}>
            All ({r.records.length})
          </Link>
          {SPEED_RESULTS.map((k) => (
            <Link
              key={k}
              href={href({ ...(repFilter ? { rep: repFilter } : {}), result: k })}
              className={`cara-pill${result === k ? " on" : ""}`}
            >
              {SPEED_RESULT_LABELS[k]} ({r.records.filter((x) => x.result === k).length})
            </Link>
          ))}
          {repFilter && (
            <Link href={href(result ? { result } : {})} className="cara-pill">
              Everyone
            </Link>
          )}
        </div>

        {shown.length === 0 ? (
          <Empty>No leads match.</Empty>
        ) : (
          <Table head={["Lead", "Source", "Arrived", "First call", { label: "Wait", align: "right" }, "Result", "Call", "By"]}>
            {shown.map((row) => (
              <tr key={row.leadId}>
                <td className="whitespace-nowrap">
                  <LeadLink id={row.leadId} name={row.leadName} />
                </td>
                <td className="whitespace-nowrap text-[12px] text-cara-muted">{sourceLabel(row.source)}</td>
                <td className="whitespace-nowrap text-[12px]">{formatIst(row.arrivedAt)}</td>
                <td className="whitespace-nowrap text-[12px]">{row.firstCallAt ? formatIst(row.firstCallAt) : "—"}</td>
                <Num>{row.tatMs == null ? "—" : talkTime(row.tatMs / 1000)}</Num>
                <td className={`whitespace-nowrap text-[12px] font-medium ${RESULT_TONE[row.result]}`}>
                  {SPEED_RESULT_LABELS[row.result]}
                </td>
                <td className="whitespace-nowrap text-[12px] text-cara-muted">
                  {row.connected == null ? "—" : row.connected ? "Connected" : "Not connected"}
                </td>
                <td className="whitespace-nowrap text-[12px] text-cara-muted">{row.repName ?? "No owner"}</td>
              </tr>
            ))}
          </Table>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between text-[12px]">
            {current > 1 ? (
              <Link href={href({ ...keep, page: String(current - 1) })} className="underline">
                Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-cara-faint">
              Page {current} of {pages}
            </span>
            {current < pages ? (
              <Link href={href({ ...keep, page: String(current + 1) })} className="underline">
                Next
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

// ── 14. Telecaller Activity ──────────────────────────────────────────

/// The calling window as a strip: active stretches filled, everything else empty.
function ActivityStrip({ day }: { day: ActivityDay }) {
  const w = permittedWindow(day.day);
  const start = w.start.getTime();
  const span = w.end.getTime() - start;
  const pos = (ms: number) => `${((ms - start) / span) * 100}%`;
  return (
    <div className="relative h-2.5 w-40 overflow-hidden rounded-sm bg-cara-surface-2" aria-hidden>
      {day.active.map((i) => (
        <div
          key={i.start}
          className="absolute inset-y-0 bg-[var(--state-success-tx)] opacity-70"
          style={{ left: pos(i.start), width: `${((i.end - i.start) / span) * 100}%` }}
        />
      ))}
    </div>
  );
}

const DAY_ROWS_MAX = 100;

export async function ActivitySection({
  range,
  repFilter,
  href,
}: {
  range: DateRange;
  repFilter?: string;
  href: Href;
}) {
  const r = await telecallerActivity(range);
  const dayRows = r.reps
    .filter((x) => !repFilter || x.repId === repFilter)
    .flatMap((x) => x.days.map((d) => ({ rep: x, d })))
    .sort((a, b) => b.d.day.localeCompare(a.d.day) || a.rep.repName.localeCompare(b.rep.repName));

  return (
    <div className="space-y-5">
      <Caveat>
        Active means the CRM was open or a call was in progress, less any Break they set. There&rsquo;s
        no shift roster, so each day runs from first to last activity within the calling window, and
        inactive periods are the gaps of 5 minutes or more in between. An open tab counts as active
        even if nobody is at the desk. A day with no activity is counted apart, since it may be a day off.
      </Caveat>

      {r.recordingSince ? (
        <p className="cara-note text-[12px]">Activity has been recorded since {formatIst(r.recordingSince)}.</p>
      ) : (
        <div className="cara-callout cara-callout-info">
          No activity has been recorded yet. It starts the next time someone has the CRM open.
        </div>
      )}

      {r.reps.length === 0 ? (
        <Empty>No telecallers to show.</Empty>
      ) : (
        <Table
          head={[
            "Telecaller",
            "Team",
            { label: "Days active", align: "right" },
            { label: "No activity", align: "right" },
            { label: "Active", align: "right" },
            { label: "Inactive", align: "right" },
            { label: "Active share", align: "right" },
          ]}
        >
          {r.reps.map((row) => (
            <tr key={row.repId}>
              <td className="whitespace-nowrap text-cara-ink">
                <Link href={href({ rep: row.repId })} className="hover:underline">
                  {row.repName}
                </Link>
              </td>
              <td className="whitespace-nowrap text-[12px] text-cara-muted">{salesTeamLabel(row.team)}</td>
              <Num>{row.daysActive}</Num>
              <Num>{row.daysNoActivity}</Num>
              <Num>{talkTime(row.activeMs / 1000)}</Num>
              <Num>{talkTime(row.inactiveMs / 1000)}</Num>
              <Num strong>{pct(row.activePct)}</Num>
            </tr>
          ))}
        </Table>
      )}

      <Panel
        title="Day by day"
        hint={
          dayRows.length > DAY_ROWS_MAX
            ? `Latest ${DAY_ROWS_MAX} of ${dayRows.length}. Pick a person or a shorter range for the rest.`
            : "The strip shows the calling window, with active time filled in."
        }
      >
        {repFilter && (
          <Link href={href({})} className="cara-pill">
            Everyone
          </Link>
        )}
        {dayRows.length === 0 ? (
          <Empty>No activity recorded in this range.</Empty>
        ) : (
          <Table
            head={[
              "Day",
              "Telecaller",
              "First",
              "Last",
              "",
              { label: "Active", align: "right" },
              { label: "Inactive", align: "right" },
              "Inactive periods",
            ]}
          >
            {dayRows.slice(0, DAY_ROWS_MAX).map(({ rep, d }) => (
              <tr key={`${rep.repId}-${d.day}`}>
                <td className="whitespace-nowrap text-[12px]">{istDayLabel(d.day)}</td>
                <td className="whitespace-nowrap text-cara-ink">{rep.repName}</td>
                <td className="whitespace-nowrap text-[12px] tabular-nums">{d.first ? istTime(d.first) : "—"}</td>
                <td className="whitespace-nowrap text-[12px] tabular-nums">{d.last ? istTime(d.last) : "—"}</td>
                <td>
                  <ActivityStrip day={d} />
                </td>
                <Num>{talkTime(d.activeMs / 1000)}</Num>
                <Num>{talkTime(d.inactiveMs / 1000)}</Num>
                <td className="text-[12px] text-cara-muted">
                  {d.periods.length === 0
                    ? "None"
                    : d.periods.map((p) => (
                        <span key={p.start} className="mr-2 inline-block whitespace-nowrap tabular-nums">
                          {istTime(p.start)}–{istTime(p.end)}
                          {p.kind === "break" ? " (break)" : ""}
                        </span>
                      ))}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

// ── 15. Follow-Ups ───────────────────────────────────────────────────

const FOLLOW_UP_STATUS: Record<FollowUpStatus, { label: string; tag: string }> = {
  missed_today: { label: "Missed today", tag: "tag-fushia" },
  overdue: { label: "Overdue", tag: "tag-tangerine" },
  due_later_today: { label: "Due later today", tag: "tag-blue" },
  carried_over: { label: "Carried over", tag: "tag-neutral" },
};

/// `repId` scopes everything to one person (My numbers). `repFilter` (Reports) keeps the
/// team table whole and narrows the lead list to the telecaller picked in it.
export async function FollowUpSection({ repId, repFilter, href }: { repId?: string; repFilter?: string; href?: Href }) {
  const r = await followUpTracking({ repId });
  const nameOf = new Map(r.reps.map((x) => [x.repId, x.repName]));
  const leads = repFilter ? r.leads.filter((l) => l.repId === repFilter) : r.leads;
  const needsAction = r.totals.missedToday + r.totals.overdue;

  return (
    <div className="space-y-5">
      <Caveat>
        Counted per lead: a lead with several follow-ups counts once, by its soonest one. A live
        picture, whatever date range is chosen. Doing a follow-up takes it off. Leads marked lost
        aren&rsquo;t counted. <strong className="font-medium">Carried over</strong> is overdue on leads
        from the previous CRM, which arrived already late, so it&rsquo;s kept apart.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label="Leads to follow up now" value={needsAction} tone={needsAction > 0 ? "danger" : "good"} hint="overdue + missed today" />
        <Tile label="Overdue" value={r.totals.overdue} tone={r.totals.overdue > 0 ? "warning" : undefined} hint="due before today" />
        <Tile label="Missed today" value={r.totals.missedToday} tone={r.totals.missedToday > 0 ? "danger" : undefined} hint="due earlier today" />
        <Tile label="Due later today" value={r.totals.dueLaterToday} />
        <Tile label="Carried over" value={r.totals.carriedOver} hint="from the previous CRM" />
      </div>

      {!repId && (
        <Table
          head={[
            "Telecaller",
            { label: "To follow up now", align: "right" },
            { label: "Overdue", align: "right" },
            { label: "Missed today", align: "right" },
            { label: "Due later today", align: "right" },
            { label: "Carried over", align: "right" },
          ]}
          note="Leads, not follow-ups. Click a name to list only their leads."
        >
          {r.reps.map((row) => (
            <tr key={row.repId} className={row.repId === repFilter ? "bg-cara-surface-2" : undefined}>
              <td className="whitespace-nowrap text-cara-ink">
                {href ? (
                  <Link href={href({ rep: row.repId })} className="hover:underline">
                    {row.repName}
                  </Link>
                ) : (
                  row.repName
                )}
              </td>
              <Num strong>{row.missedToday + row.overdue}</Num>
              <Num>{row.overdue}</Num>
              <Num>{row.missedToday}</Num>
              <Num>{row.dueLaterToday}</Num>
              <Num>{row.carriedOver}</Num>
            </tr>
          ))}
        </Table>
      )}

      <Panel
        title={repFilter ? `Leads to follow up · ${nameOf.get(repFilter) ?? "one telecaller"}` : "Leads to follow up"}
        hint={
          r.leadsNotListed > 0
            ? `Showing ${r.leads.length} leads. ${r.leadsNotListed} more are counted above.`
            : "Missed today first, then overdue (most recent first), then due later today."
        }
      >
        {repFilter && href && (
          <Link href={href({})} className="cara-pill">
            Everyone
          </Link>
        )}
        {leads.length === 0 ? (
          <Empty>Nothing to follow up.</Empty>
        ) : (
          <Table head={["Lead", ...(repId ? [] : ["Telecaller"]), "Status", "Next follow-up", "Other follow-ups", "Last call"]}>
            {leads.map((l) => (
              <tr key={l.leadId}>
                <td className="whitespace-nowrap">
                  <LeadLink id={l.leadId} name={l.leadName} />
                </td>
                {!repId && <td className="whitespace-nowrap text-[12px] text-cara-muted">{nameOf.get(l.repId) ?? "—"}</td>}
                <td className="whitespace-nowrap">
                  <span className={`tag ${FOLLOW_UP_STATUS[l.status].tag}`}>{FOLLOW_UP_STATUS[l.status].label}</span>
                </td>
                <td className="text-[12px]">
                  <span className="whitespace-nowrap">{formatIst(l.next.dueAt)}</span>
                  <div className="text-cara-muted">{l.next.title}</div>
                </td>
                <td className="text-[12px] text-cara-muted">
                  {l.others.length === 0
                    ? "—"
                    : l.others.map((o, i) => (
                        <div key={i} className="whitespace-nowrap">
                          {formatIst(o.dueAt)} · {o.title}
                        </div>
                      ))}
                </td>
                <td className="whitespace-nowrap text-[12px] text-cara-muted">
                  {l.lastCall ? `${formatIst(l.lastCall.at)} · ${l.lastCall.connected ? "connected" : "not connected"}` : "No call yet"}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
