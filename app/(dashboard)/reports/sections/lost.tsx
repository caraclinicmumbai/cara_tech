// Reports 6 & 8: Lost Lead Analysis and Lost Quote Analysis.

import { lostLeadAnalysis, lostQuoteAnalysis } from "@/lib/reports/lost";
import type { DateRange } from "@/lib/reports/range";
import { inr, inrShort, pct } from "@/lib/reports/shared";
import { formatIstDate } from "@/lib/datetime";
import { Bars, Caveat, Empty, LeadLink, Num, Panel, Table, Tile } from "@/components/ReportUI";

// ── 6. Lost Lead Analysis ────────────────────────────────────────────

export async function LostLeadSection({ range }: { range: DateRange }) {
  const r = await lostLeadAnalysis(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Leads marked Lost in this range, by the reason given. A{" "}
        <strong className="font-medium">premature loss</strong> is one recorded before the lead ever
        reached a consultation — the counsellor was alerted at the time, and a high share here usually
        means leads are being closed rather than worked. The loss rate compares losses recorded in the
        window against leads received in it, so it&rsquo;s a health signal, not a cohort outcome.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Leads lost" value={r.lost.toLocaleString("en-IN")} />
        <Tile
          label="Loss rate"
          value={pct(r.lossRatePct)}
          hint={`${r.lost} lost / ${r.created} received`}
          tone={r.lossRatePct != null && r.lossRatePct > 50 ? "warning" : undefined}
        />
        <Tile
          label="Premature"
          value={r.premature}
          hint={`${pct(r.prematurePct)} — lost before consulting`}
          tone={r.prematurePct != null && r.prematurePct > 40 ? "danger" : undefined}
        />
        <Tile
          label="Median survival"
          value={r.medianDaysToLoss == null ? "—" : `${r.medianDaysToLoss.toFixed(1)} d`}
          hint="from arrival to loss"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Why we lose them" hint="The preset tag chosen when the lead was closed.">
          <Bars
            items={r.byTag.map((t) => ({
              label: t.tag,
              value: t.count,
              sub: `${pct(t.sharePct)}${t.premature ? ` · ${t.premature} premature` : ""}`,
            }))}
            emptyText="No leads lost in this range."
          />
        </Panel>
        <Panel title="Loss rate by source" hint="Which channels send us people we can't convert.">
          {r.bySource.length === 0 ? (
            <Empty>Nothing to compare.</Empty>
          ) : (
            <Table
              head={[
                "Source",
                { label: "Received", align: "right" },
                { label: "Lost", align: "right" },
                { label: "Rate", align: "right" },
              ]}
            >
              {r.bySource.map((s) => (
                <tr key={s.source}>
                  <td className="text-cara-ink">{s.label}</td>
                  <Num>{s.created}</Num>
                  <Num>{s.lost}</Num>
                  <Num strong>{pct(s.lossRatePct)}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      {r.unexplained > 0 && (
        <div className="cara-callout cara-callout-warning">
          {r.unexplained} lead{r.unexplained === 1 ? " was" : "s were"} closed with neither a tag nor a
          written reason. That much of this report is missing.
        </div>
      )}

      {r.written.length > 0 && (
        <Panel
          title="In their own words"
          hint="Losses recorded with a written reason and no preset tag — where the unclassified truth is."
        >
          <Table head={["Lead", "Lost", "Reason"]}>
            {r.written.map((w) => (
              <tr key={w.leadId}>
                <td>
                  <LeadLink id={w.leadId} name={w.leadName} />
                </td>
                <td className="whitespace-nowrap text-cara-muted">{formatIstDate(w.lostAt)}</td>
                <td className="text-cara-ink">{w.reason}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      )}
    </div>
  );
}

// ── 8. Lost Quote Analysis 💰 ────────────────────────────────────────

export async function LostQuoteSection({ range }: { range: DateRange }) {
  const r = await lostQuoteAnalysis(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Quotes that died in this range, by how and by treatment. Three ways a quote is lost:{" "}
        <strong className="font-medium">rejected</strong> (someone said no, with a reason from the
        list), <strong className="font-medium">withdrawn</strong> (we pulled it), and{" "}
        <strong className="font-medium">lapsed</strong> — nobody ever answered and the validity ran out.
        Lapsed is usually the biggest, and it&rsquo;s a follow-up failure rather than a price problem.
        Rejections and withdrawals are dated by the quote&rsquo;s last edit, since a quote records no
        separate closing date.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Quotes lost" value={r.total} hint={`${r.wonInRange} converted in the same range`} />
        <Tile
          label="Loss rate"
          value={pct(r.lossRatePct)}
          hint="lost / (lost + converted)"
          tone={r.lossRatePct != null && r.lossRatePct > 60 ? "warning" : undefined}
        />
        <Tile label="Value lost" value={inrShort(r.valueLost)} tone="danger" />
        <Tile
          label="Lapsed"
          value={r.lapsed}
          hint="validity ran out, no answer"
          tone={r.lapsed > r.rejected ? "warning" : undefined}
        />
      </div>

      {r.pricingSignals.length > 0 && (
        <div className="cara-callout cara-callout-warning space-y-1">
          <strong>Price is the dominant objection on:</strong>
          <ul className="ml-4 list-disc">
            {r.pricingSignals.map((s) => (
              <li key={s.treatment}>
                <strong>{s.treatment}</strong> — {s.priceRejections} of {s.rejections} rejections were on
                price ({pct(s.pricePct)}).
              </li>
            ))}
          </ul>
          <p className="text-[12px]">
            Worth checking the price against the market before training counsellors to argue it.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Why quotes die">
          <Bars
            items={r.byReason.map((x) => ({
              label: x.reason,
              value: x.count,
              sub: `${pct(x.sharePct)} · ${inrShort(x.valueLost)}`,
            }))}
            emptyText="No quotes lost in this range."
          />
        </Panel>
        <Panel title="Where the money went" hint="Value lost per treatment.">
          <Bars
            items={r.byTreatment.slice(0, 10).map((t) => ({
              label: t.treatment,
              value: t.valueLost,
              display: inrShort(t.valueLost),
              sub: `${t.total} quote${t.total === 1 ? "" : "s"}`,
            }))}
            emptyText="Nothing lost in this range."
          />
        </Panel>
      </div>

      {r.byTreatment.length > 0 && (
        <Table
          head={[
            "Treatment",
            { label: "Rejected", align: "right" },
            { label: "Withdrawn", align: "right" },
            { label: "Lapsed", align: "right" },
            { label: "Total", align: "right" },
            { label: "On price", align: "right" },
            { label: "Value lost", align: "right" },
          ]}
          note="“On price” is the share of that treatment's REJECTIONS given as “Price too high” — lapsed quotes never gave a reason, so they aren't in that denominator."
        >
          {r.byTreatment.map((t) => (
            <tr key={t.key}>
              <td className="text-cara-ink">{t.treatment}</td>
              <Num>{t.rejected}</Num>
              <Num>{t.withdrawn}</Num>
              <Num>{t.lapsed}</Num>
              <Num strong>{t.total}</Num>
              <Num>{t.rejected > 0 ? pct(t.pricePct) : "—"}</Num>
              <Num strong>{inr(t.valueLost)}</Num>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
