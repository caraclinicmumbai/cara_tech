// Reports 7, 9 & 10: Treatment Mix, Multi-Quote, Repeat Treatment.

import { treatmentMix, multiQuoteReport, repeatTreatment } from "@/lib/reports/money";
import type { DateRange } from "@/lib/reports/range";
import { days, inr, inrShort, pct } from "@/lib/reports/shared";
import { formatIstDate } from "@/lib/datetime";
import { Bars, Caveat, Empty, LeadLink, Num, Panel, Table, Tile } from "@/components/ReportUI";

// ── 7. Treatment Mix 💰 ──────────────────────────────────────────────

export async function TreatmentMixSection({ range }: { range: DateRange }) {
  const r = await treatmentMix(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Two different questions on one table.{" "}
        <strong className="font-medium">Quoted / converted / rate</strong> follows the quotes{" "}
        <em>raised</em> in this range and asks how many have converted since — a cohort that is still
        deciding, so a recent range always understates its eventual rate.{" "}
        <strong className="font-medium">Revenue</strong> counts quotes that <em>converted</em> in the
        range, whenever they were raised: the money that actually landed. A quote is worth its invoice
        where one exists, and its quoted total (after discount, including GST) where one doesn&rsquo;t.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Quotes raised" value={r.quoted} hint={`${r.converted} converted so far`} />
        <Tile
          label="Conversion rate"
          value={pct(r.conversionPct)}
          hint="of the quotes raised in this range"
        />
        <Tile label="Revenue" value={inrShort(r.revenue)} tone="good" hint="converted in this range" />
        <Tile
          label="Average sale"
          value={inrShort(r.avgConvertedValue)}
          hint={`avg quote ${inrShort(r.avgQuoteValue)}`}
        />
      </div>

      {r.rows.length === 0 ? (
        <Empty>No quotes raised or converted in this range.</Empty>
      ) : (
        <>
          <Table
            head={[
              "Treatment",
              { label: "Quoted", align: "right" },
              { label: "Converted", align: "right" },
              { label: "Rate", align: "right" },
              { label: "Still open", align: "right" },
              { label: "Avg quote", align: "right" },
              { label: "Avg sale", align: "right" },
              { label: "Revenue", align: "right" },
              { label: "Share", align: "right" },
            ]}
          >
            {r.rows.map((t) => (
              <tr key={t.key}>
                <td className="text-cara-ink">{t.treatment}</td>
                <Num>{t.quoted}</Num>
                <Num>{t.converted}</Num>
                <Num>{pct(t.conversionPct)}</Num>
                <Num>{t.open}</Num>
                <Num>{inr(t.avgQuoted)}</Num>
                <Num>{inr(t.avgConverted)}</Num>
                <Num strong>{inr(t.revenue)}</Num>
                <Num>{pct(t.revenueSharePct)}</Num>
              </tr>
            ))}
          </Table>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Converts best" hint="At least 3 quotes raised in the range.">
              <Bars
                items={r.strongest.map((t) => ({
                  label: t.treatment,
                  value: t.conversionPct ?? 0,
                  display: pct(t.conversionPct),
                  sub: `${t.converted}/${t.quoted}`,
                }))}
                emptyText="Not enough quotes yet to rank."
              />
            </Panel>
            <Panel title="Converts worst" hint="Where the pitch, the price or the fit needs work.">
              <Bars
                items={r.weakest.map((t) => ({
                  label: t.treatment,
                  value: t.conversionPct ?? 0,
                  display: pct(t.conversionPct),
                  sub: `${t.converted}/${t.quoted}`,
                }))}
                emptyText="Not enough quotes yet to rank."
              />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

// ── 9. Multi-Quote Report 💰 ─────────────────────────────────────────

export async function MultiQuoteSection({ range }: { range: DateRange }) {
  const r = await multiQuoteReport(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Patients who bought in this range, and whether they bought more than one{" "}
        <em>different</em> treatment (a second course of the same treatment belongs to the Repeat
        report). The pairs below look at each patient&rsquo;s whole history, not just this window —
        the question is what goes with what, whenever it happened. This is the list a counsellor is
        trained from: these are the combinations patients actually take. Treatments are matched by the
        name on the quote, so two sizes of the same procedure count as two treatments — which is
        usually what you want, since they&rsquo;re priced and sold separately.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Patients who bought" value={r.buyers} />
        <Tile
          label="Bought two or more"
          value={r.multiBuyers}
          hint={pct(r.multiBuyerPct)}
          tone={r.multiBuyers > 0 ? "good" : undefined}
        />
        <Tile
          label="Worth per patient"
          value={inrShort(r.avgMultiValue)}
          hint={`single-treatment ${inrShort(r.avgSingleValue)}`}
        />
        <Tile
          label="Uplift"
          value={r.upliftPct == null ? "—" : `${r.upliftPct >= 0 ? "+" : ""}${r.upliftPct.toFixed(0)}%`}
          hint="multi vs single treatment"
          tone={r.upliftPct != null && r.upliftPct > 0 ? "good" : undefined}
        />
      </div>

      {r.offeredNotTaken > 0 && (
        <div className="cara-callout cara-callout-info">
          <strong>{r.offeredNotTaken}</strong> patient{r.offeredNotTaken === 1 ? " was" : "s were"} quoted
          for a second treatment and took only one. The offer was made and didn&rsquo;t land — worth a
          follow-up while they&rsquo;re still in care.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Which treatments go together" hint="Counted per patient, across their whole history.">
          {r.pairs.length === 0 ? (
            <Empty>No patient has bought two different treatments yet.</Empty>
          ) : (
            <Table
              head={["Pair", { label: "Patients", align: "right" }, { label: "Combined value", align: "right" }]}
            >
              {r.pairs.map((p) => (
                <tr key={`${p.a}|${p.b}`}>
                  <td className="text-cara-ink">
                    {p.a} <span className="text-cara-faint">+</span> {p.b}
                  </td>
                  <Num strong>{p.patients}</Num>
                  <Num>{inr(p.revenue)}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <Panel title="Biggest patients" hint="Most treatments taken, then by value.">
          {r.topPatients.length === 0 ? (
            <Empty>No multi-treatment patients yet.</Empty>
          ) : (
            <Table head={["Patient", "Treatments", { label: "Value", align: "right" }]}>
              {r.topPatients.map((p) => (
                <tr key={p.leadId}>
                  <td>
                    <LeadLink id={p.leadId} name={p.leadName} />
                  </td>
                  <td className="text-cara-muted">{p.treatments.join(", ")}</td>
                  <Num strong>{inr(p.value)}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── 10. Repeat Treatment Report 💰 ───────────────────────────────────

export async function RepeatSection({ range }: { range: DateRange }) {
  const r = await repeatTreatment(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Patients coming back for another course of the <em>same</em> treatment — a quote at cycle 2 or
        later that converted in this range. The gap is measured from the previous cycle&rsquo;s
        conversion, however long ago that was, so it&rsquo;s the real interval rather than a
        window-limited one. The repeat rate compares repeat patients against everyone who converted
        anything in the range.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile
          label="Patients who came back"
          value={r.repeatPatients}
          hint={`${r.repeats} repeat purchase${r.repeats === 1 ? "" : "s"}`}
          tone={r.repeatPatients > 0 ? "good" : undefined}
        />
        <Tile label="Repeat rate" value={pct(r.repeatRatePct)} hint={`of ${r.buyers} who bought`} />
        <Tile label="Repeat revenue" value={inrShort(r.revenue)} hint={`avg ${inrShort(r.avgValue)}`} />
        <Tile
          label="Typical gap"
          value={days(r.medianGapMs)}
          hint={r.meanGapMs == null ? undefined : `mean ${days(r.meanGapMs)}`}
        />
      </div>

      {r.byTreatment.length === 0 ? (
        <Empty>No repeat treatments converted in this range.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="What people come back for">
            <Table
              head={[
                "Treatment",
                { label: "Repeats", align: "right" },
                { label: "Patients", align: "right" },
                { label: "Typical gap", align: "right" },
                { label: "Revenue", align: "right" },
              ]}
            >
              {r.byTreatment.map((t) => (
                <tr key={t.key}>
                  <td className="text-cara-ink">{t.treatment}</td>
                  <Num>{t.repeats}</Num>
                  <Num>{t.patients}</Num>
                  <Num>{days(t.medianGapMs)}</Num>
                  <Num strong>{inr(t.revenue)}</Num>
                </tr>
              ))}
            </Table>
          </Panel>
          <Panel title="Recent returns" hint="Newest first.">
            <Table
              head={[
                "Patient",
                "Treatment",
                { label: "Cycle", align: "right" },
                { label: "Gap", align: "right" },
                { label: "Value", align: "right" },
              ]}
            >
              {r.recent.map((q, i) => (
                <tr key={`${q.leadId}-${q.treatment}-${q.cycle}-${i}`}>
                  <td>
                    <LeadLink id={q.leadId} name={q.leadName} />
                    <div className="text-[11px] text-cara-faint">{formatIstDate(q.convertedAt)}</div>
                  </td>
                  <td className="text-cara-muted">{q.treatment}</td>
                  <Num>#{q.cycle}</Num>
                  <Num>{days(q.gapMs)}</Num>
                  <Num strong>{inr(q.value)}</Num>
                </tr>
              ))}
            </Table>
          </Panel>
        </div>
      )}
    </div>
  );
}
