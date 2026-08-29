// Reports 1–3: Lead Inflow, AI Contact Rate, Human Handoff Speed.

import { leadInflow, aiContactRate, handoffSpeed } from "@/lib/reports/funnel";
import type { DateRange } from "@/lib/reports/range";
import { duration, pct } from "@/lib/reports/shared";
import { formatIst } from "@/lib/datetime";
import { Bars, Caveat, DayChart, Empty, LeadLink, Num, Panel, Table, Tile } from "@/components/ReportUI";

// ── 1. Lead Inflow ───────────────────────────────────────────────────

export async function InflowSection({ range }: { range: DateRange }) {
  const r = await leadInflow(range);
  const trend =
    r.changePct == null
      ? undefined
      : `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(0)}% vs previous ${range.days} days`;

  return (
    <div className="space-y-5">
      <Caveat>
        Leads created in this range, by the door they came through. Deleted leads are excluded;
        duplicates are counted (they arrived) and flagged separately below.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Leads received"
          value={r.total.toLocaleString("en-IN")}
          hint={trend}
          tone={r.changePct == null ? undefined : r.changePct >= 0 ? "good" : "warning"}
        />
        <Tile label="Per day" value={r.perDay == null ? "—" : r.perDay.toFixed(1)} />
        <Tile
          label="Duplicates"
          value={r.duplicates}
          hint="matched an existing lead"
          tone={r.duplicates > 0 ? "warning" : undefined}
        />
        <Tile
          label="Held for review"
          value={r.heldForReview}
          hint="submission burst — vetted by hand"
          tone={r.heldForReview > 0 ? "warning" : undefined}
        />
      </div>

      <Panel title="Day by day" hint="Every day in the range, including the quiet ones.">
        <DayChart points={r.byDay.map((d) => ({ day: d.day, value: d.count }))} label="Leads per day" />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By source">
          <Bars
            items={r.bySource.map((s) => ({
              label: s.label,
              value: s.count,
              sub: pct(s.sharePct),
            }))}
          />
        </Panel>
        <Panel title="By campaign" hint="Top campaigns by volume; leads with no campaign tag are omitted.">
          <Bars
            items={r.byCampaign.map((s) => ({ label: s.label, value: s.count, sub: pct(s.sharePct) }))}
            emptyText="No campaign attribution on this range's leads."
          />
        </Panel>
        <Panel title="By branch">
          <Bars items={r.byBranch.map((s) => ({ label: s.label, value: s.count, sub: pct(s.sharePct) }))} />
        </Panel>
        <Panel title="Intake quality" hint="What arrived but can't be worked as-is.">
          <Bars
            items={[
              { label: "Duplicate of an existing lead", value: r.duplicates },
              { label: "Held for review (spam burst)", value: r.heldForReview },
              { label: "Opted out on arrival", value: r.optedOut },
            ].filter((i) => i.value > 0)}
            emptyText="Nothing flagged — every lead in this range is workable."
          />
        </Panel>
      </div>
    </div>
  );
}

// ── 2. AI Contact Rate ───────────────────────────────────────────────

export async function AiContactSection({ range }: { range: DateRange }) {
  const r = await aiContactRate(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Calls the AI placed (first attempts and reconfirmations — human handover calls are excluded).
        <strong className="font-medium"> Reached</strong> means a person answered and a decision was
        recorded, so a firm &ldquo;not interested&rdquo; counts as a contact: the AI did its job, the
        answer was no. Calls with no outcome written back are counted as attempts but never as reached.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Contact rate"
          value={pct(r.callContactRatePct)}
          hint={`${r.reached.toLocaleString("en-IN")} of ${r.attempts.toLocaleString("en-IN")} calls`}
          tone={r.callContactRatePct != null && r.callContactRatePct < 30 ? "warning" : "good"}
        />
        <Tile
          label="People reached"
          value={pct(r.leadContactRatePct)}
          hint={`${r.leadsReached} of ${r.leadsAttempted} leads tried`}
        />
        <Tile
          label="Never reached"
          value={r.neverReached}
          hint="tried, never got through"
          tone={r.neverReached > 0 ? "warning" : undefined}
        />
        <Tile
          label="Avg talk time"
          value={r.avgTalkSeconds == null ? "—" : `${Math.round(r.avgTalkSeconds)}s`}
          hint="connected calls only"
        />
      </div>

      <Panel title="Attempts and contacts, day by day" hint="Beige = calls placed. Green = reached.">
        <DayChart
          points={r.byDay.map((d) => ({ day: d.day, value: d.attempts, second: d.reached }))}
          label="AI calls per day"
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Call outcomes">
          <Bars
            items={r.byOutcome.map((o) => ({ label: o.label, value: o.count, sub: pct(o.sharePct) }))}
          />
        </Panel>
        <Panel
          title="Persistence"
          hint="How many tries it takes when the AI does get through — and whether reconfirmations land better than first attempts."
        >
          <div className="space-y-3">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-cara-ink">Average attempts before contact</span>
              <span className="tabular-nums text-cara-muted">
                {r.avgAttemptsToReach == null ? "—" : r.avgAttemptsToReach.toFixed(1)}
              </span>
            </div>
            <Bars
              items={r.byCallType.map((t) => ({
                label: t.label,
                value: t.attempts,
                display: `${t.reached}/${t.attempts}`,
                sub: pct(t.ratePct),
              }))}
              emptyText="No AI calls in this range."
            />
            {r.unknownOutcome > 0 && (
              <p className="cara-note text-[11px] text-warning">
                {r.unknownOutcome} call{r.unknownOutcome === 1 ? "" : "s"} finished with no outcome written
                back — they&rsquo;re in the attempt count but can never count as reached, so the true
                contact rate is at least this figure.
              </p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ── 3. Human Handoff Speed ───────────────────────────────────────────

export async function HandoffSection({ range }: { range: DateRange }) {
  const r = await handoffSpeed(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Handovers that fired in this range and how long each waited for a human.{" "}
        <strong className="font-medium">Picked up</strong> means a logged action — a call recorded
        against the lead, or a counsellor-typed WhatsApp message. A counsellor who dials from their
        own handset leaves no trace and reads here as never picked up. Each lead carries only its most
        recent handover, so a lead handed over twice appears once.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Handovers" value={r.handovers} hint={`${r.pickedUp} picked up`} />
        <Tile
          label="Median wait"
          value={duration(r.medianMs)}
          hint={r.meanMs == null ? undefined : `mean ${duration(r.meanMs)}`}
        />
        <Tile
          label={`Within ${r.slaHours}h SLA`}
          value={pct(r.withinSlaPct)}
          hint="of all handovers, answered or not"
          tone={r.withinSlaPct != null && r.withinSlaPct < 80 ? "warning" : "good"}
        />
        <Tile
          label="Never picked up"
          value={r.stillWaiting}
          tone={r.stillWaiting > 0 ? "danger" : "good"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="How long they waited">
          <Bars
            items={r.buckets.map((b) => ({ label: b.label, value: b.count }))}
            emptyText="No handovers picked up in this range."
          />
        </Panel>
        <Panel title="By counsellor">
          {r.byRep.length === 0 ? (
            <Empty>No handovers in this range.</Empty>
          ) : (
            <Table
              head={["Counsellor", { label: "Handed", align: "right" }, { label: "Picked up", align: "right" }, { label: "Median", align: "right" }]}
            >
              {r.byRep.map((rep) => (
                <tr key={rep.repName}>
                  <td className="text-cara-ink">{rep.repName}</td>
                  <Num>{rep.handovers}</Num>
                  <Num>
                    {rep.pickedUp}
                    <span className="ml-1 text-[11px] text-cara-faint">
                      ({rep.withinSla} in SLA)
                    </span>
                  </Num>
                  <Num>{duration(rep.medianMs)}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      {r.waiting.length > 0 && (
        <Panel title="Still waiting" hint="Handed over and never touched — oldest first.">
          <Table head={["Lead", "Counsellor", "Handed over", { label: "Waiting", align: "right" }, "Reason"]}>
            {r.waiting.map((row) => (
              <tr key={row.leadId}>
                <td>
                  <LeadLink id={row.leadId} name={row.leadName} />
                </td>
                <td className="text-cara-muted">{row.repName}</td>
                <td className="text-cara-muted">{formatIst(row.handoverAt)}</td>
                <Num strong>{duration(row.waitMs)}</Num>
                <td className="max-w-xs truncate text-cara-faint" title={row.reason ?? ""}>
                  {row.reason ?? "—"}
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}

      {r.slowest.length > 0 && (
        <Panel title="Slowest pickups" hint="Answered, but not quickly.">
          <Table head={["Lead", "Counsellor", "Handed over", { label: "Wait", align: "right" }, "Via"]}>
            {r.slowest.map((row) => (
              <tr key={row.leadId}>
                <td>
                  <LeadLink id={row.leadId} name={row.leadName} />
                </td>
                <td className="text-cara-muted">{row.repName}</td>
                <td className="text-cara-muted">{formatIst(row.handoverAt)}</td>
                <Num strong>{duration(row.waitMs)}</Num>
                <td className="text-cara-faint">{row.channel === "call" ? "Call" : "WhatsApp"}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}
    </div>
  );
}
