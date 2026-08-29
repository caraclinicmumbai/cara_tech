// Reports 4–5: Counsellor Performance and Source Attribution.

import Link from "next/link";
import { counsellorPerformance } from "@/lib/reports/people";
import { sourceAttribution } from "@/lib/reports/attribution";
import type { DateRange } from "@/lib/reports/range";
import { duration, inr, inrShort, pct } from "@/lib/reports/shared";
import { Caveat, Empty, Num, Panel, Table, Tile } from "@/components/ReportUI";

// ── 4. Counsellor Performance ────────────────────────────────────────

export async function CounsellorSection({
  range,
  showMoney,
}: {
  range: DateRange;
  showMoney: boolean;
}) {
  const r = await counsellorPerformance(range);

  return (
    <div className="space-y-5">
      <Caveat>
        A counsellor is credited with the leads <strong className="font-medium">assigned to them</strong>{" "}
        in this range, so a handover moves the credit with the work.{" "}
        <strong className="font-medium">Consultations</strong> are read from the lead&rsquo;s current
        stage, plus anyone who bought (you can&rsquo;t have a treatment without being consulted, even
        if nobody moved the stage). A lead who booked and was later marked Lost reads as lost, not as a
        consultation, until there are real appointment records to count instead.{" "}
        <strong className="font-medium">Converted</strong> counts quotes that converted inside the range;
        the conversion rate beside it follows the quotes they <em>raised</em> in the range, which is a
        cohort still deciding — expect it to rise after the window closes.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Leads assigned" value={r.totals.leads.toLocaleString("en-IN")} />
        <Tile
          label="Consultations booked"
          value={r.totals.consultationsBooked}
          hint={`${r.totals.consultationsDone} completed`}
        />
        <Tile label="Quotes raised" value={r.totals.quotesRaised} />
        {showMoney ? (
          <Tile
            label="Converted"
            value={r.totals.convertedInRange}
            hint={inrShort(r.totals.revenue)}
            tone="good"
          />
        ) : (
          <Tile label="Converted" value={r.totals.convertedInRange} tone="good" />
        )}
      </div>

      {r.rows.length === 0 ? (
        <Empty>No counsellor activity in this range.</Empty>
      ) : (
        <Table
          head={[
            "Counsellor",
            { label: "Leads", align: "right" },
            { label: "Booked", align: "right" },
            { label: "Consulted", align: "right" },
            { label: "Book rate", align: "right" },
            { label: "Calls", align: "right" },
            { label: "Median pickup", align: "right" },
            { label: "Quotes", align: "right" },
            { label: "Conv. rate", align: "right" },
            { label: "Converted", align: "right" },
            ...(showMoney ? ([{ label: "Revenue", align: "right" }] as const) : []),
          ]}
          note={
            [
              r.unassignedLeads > 0
                ? `${r.unassignedLeads} lead${r.unassignedLeads === 1 ? "" : "s"} in this range have no owner — they appear in no counsellor's row.`
                : null,
              r.unowned.quotesRaised > 0 || r.unowned.convertedInRange > 0
                ? `${r.unowned.quotesRaised} quote${r.unowned.quotesRaised === 1 ? "" : "s"} raised and ${r.unowned.convertedInRange} converted in this range have no owning counsellor${showMoney && r.unowned.revenue > 0 ? ` (${inr(r.unowned.revenue)})` : ""} — that work belongs to nobody's row above. Set an owner on the quote to credit it.`
                : null,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
        >
          {r.rows.map((row) => (
            <tr key={row.repId}>
              <td className="text-cara-ink">
                {row.repName}
                {!row.active && <span className="ml-1.5 text-[11px] text-cara-faint">(inactive)</span>}
                {row.branchName && (
                  <span className="ml-1.5 text-[11px] text-cara-faint">{row.branchName}</span>
                )}
              </td>
              <Num>{row.leads}</Num>
              <Num>{row.consultationsBooked}</Num>
              <Num>{row.consultationsDone}</Num>
              <Num>{pct(row.bookingRatePct)}</Num>
              <Num>{row.callsPlaced}</Num>
              <Num>{duration(row.medianPickupMs)}</Num>
              <Num>{row.quotesRaised}</Num>
              <Num>{pct(row.quoteConversionPct)}</Num>
              <Num strong>{row.convertedInRange}</Num>
              {showMoney && <Num strong>{inr(row.revenue)}</Num>}
            </tr>
          ))}
          <tr>
            <td className="font-semibold text-cara-ink">All counsellors</td>
            <Num strong>{r.totals.leads}</Num>
            <Num strong>{r.totals.consultationsBooked}</Num>
            <Num strong>{r.totals.consultationsDone}</Num>
            <Num>—</Num>
            <Num>—</Num>
            <Num>—</Num>
            <Num strong>{r.totals.quotesRaised}</Num>
            <Num>—</Num>
            <Num strong>{r.totals.convertedInRange}</Num>
            {showMoney && <Num strong>{inr(r.totals.revenue)}</Num>}
          </tr>
        </Table>
      )}
    </div>
  );
}

// ── 5. Source Attribution ────────────────────────────────────────────

export async function AttributionSection({
  range,
  showMoney,
}: {
  range: DateRange;
  showMoney: boolean;
}) {
  const r = await sourceAttribution(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Leads acquired in this range, followed through to consultation and to surgery. Attribution
        follows the door the person came through: a treatment quoted later in a consultation is still
        credited to the ad that brought them in. Anyone who bought counts as consulted, whether or not
        their stage was moved.{" "}
        <strong className="font-medium">Cost figures are withheld rather than guessed</strong> — a day
        with no imported spend reads as <em>unavailable</em>, never as ₹0, because a missing day
        counted as zero makes a channel look cheaper than it is.
      </Caveat>

      {r.noSpendData ? (
        <div className="cara-callout cara-callout-info">
          <strong>No ad spend has been imported yet</strong>, so the cost columns are empty. Import it
          with <code>npx tsx scripts/importAdSpend.ts &lt;file.csv&gt;</code> or post it daily to{" "}
          <code>/api/webhooks/ad-spend</code>. A day with genuinely no spend should be imported as an
          explicit <strong>0</strong> — that is a different fact from a day nobody imported.
        </div>
      ) : (
        r.incompleteSources.length > 0 && (
          <div className="cara-callout cara-callout-warning">
            Spend is missing days in this range for{" "}
            {r.incompleteSources.map((s, i) => (
              <span key={s.source}>
                {i > 0 && ", "}
                <strong>{s.label}</strong> ({s.daysMissing} day{s.daysMissing === 1 ? "" : "s"})
              </span>
            ))}
            , so those cost figures are withheld.
            {r.lastImportedDay && <> Last day imported: <strong>{r.lastImportedDay}</strong>.</>}
          </div>
        )
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Leads" value={r.totals.leads.toLocaleString("en-IN")} />
        <Tile label="Consultations" value={r.totals.consultations} />
        <Tile label="Surgeries" value={r.totals.surgeries} tone="good" />
        {showMoney ? (
          <Tile
            label="Ad spend"
            value={r.totals.spend == null ? "unavailable" : inrShort(r.totals.spend)}
            hint={r.totals.spend == null ? "not every day is imported" : `revenue ${inrShort(r.totals.revenue)}`}
            tone={r.totals.spend == null ? "warning" : undefined}
          />
        ) : (
          <Tile label="Sources" value={r.rows.filter((x) => x.leads > 0).length} />
        )}
      </div>

      <Table
        head={[
          "Source",
          { label: "Leads", align: "right" },
          { label: "Consultations", align: "right" },
          { label: "Lead → consult", align: "right" },
          { label: "Surgeries", align: "right" },
          { label: "Consult → surgery", align: "right" },
          ...(showMoney
            ? ([
                { label: "Spend", align: "right" },
                { label: "Per lead", align: "right" },
                { label: "Per consult", align: "right" },
                { label: "Per surgery", align: "right" },
                { label: "ROAS", align: "right" },
              ] as const)
            : []),
        ]}
        note="“Surgeries” counts converted quotes, so a patient taking two treatments is two — that's what cost-per-surgery divides by. “Consult → surgery” counts PATIENTS instead, so it stays a rate. Unpaid sources (referral, walk-in, website) have no ad cost: their cost cells are blank rather than zero."
      >
        {r.rows.map((row) => {
          const why = !row.paid
            ? undefined
            : row.daysMissing > 0
              ? `${row.daysMissing} day${row.daysMissing === 1 ? "" : "s"} of spend not imported`
              : row.spend == null
                ? "no spend imported for this source"
                : undefined;
          return (
            <tr key={row.source}>
              <td className="text-cara-ink">
                {row.label}
                {!row.paid && <span className="ml-1.5 text-[11px] text-cara-faint">unpaid</span>}
              </td>
              <Num>{row.leads}</Num>
              <Num>{row.consultations}</Num>
              <Num>{pct(row.leadToConsultPct)}</Num>
              <Num strong>{row.surgeries}</Num>
              <Num>{pct(row.consultToSurgeryPct)}</Num>
              {showMoney && (
                <>
                  {row.paid ? (
                    <Num unavailable={row.spend == null ? why : undefined}>{inr(row.spend)}</Num>
                  ) : (
                    <Num>—</Num>
                  )}
                  {row.paid ? (
                    <Num unavailable={row.costPerLead == null ? (why ?? "no leads to divide by") : undefined}>
                      {inr(row.costPerLead)}
                    </Num>
                  ) : (
                    <Num>—</Num>
                  )}
                  {row.paid ? (
                    <Num
                      unavailable={
                        row.costPerConsultation == null ? (why ?? "no consultations yet") : undefined
                      }
                    >
                      {inr(row.costPerConsultation)}
                    </Num>
                  ) : (
                    <Num>—</Num>
                  )}
                  {row.paid ? (
                    <Num unavailable={row.costPerSurgery == null ? (why ?? "no surgeries yet") : undefined}>
                      {inr(row.costPerSurgery)}
                    </Num>
                  ) : (
                    <Num>—</Num>
                  )}
                  <Num strong>{row.roas == null ? "—" : `${row.roas.toFixed(1)}×`}</Num>
                </>
              )}
            </tr>
          );
        })}
      </Table>

      <Panel title="Revenue by source" hint="What each channel has produced from the leads it brought in.">
        {r.rows.filter((x) => x.revenue > 0).length === 0 ? (
          <Empty>No converted quotes from this range&rsquo;s leads yet.</Empty>
        ) : (
          <Table head={["Source", { label: "Surgeries", align: "right" }, { label: "Revenue", align: "right" }]}>
            {r.rows
              .filter((x) => x.revenue > 0)
              .sort((a, b) => b.revenue - a.revenue)
              .map((row) => (
                <tr key={row.source}>
                  <td className="text-cara-ink">{row.label}</td>
                  <Num>{row.surgeries}</Num>
                  <Num strong>{showMoney ? inr(row.revenue) : "—"}</Num>
                </tr>
              ))}
          </Table>
        )}
      </Panel>

      {!showMoney && (
        <p className="cara-note text-[11px] text-cara-faint">
          Cost and revenue columns need the <code>reports.revenue</code> capability. An Admin grants it
          on the <Link href="/hierarchy" className="underline">Hierarchy</Link> screen.
        </p>
      )}
    </div>
  );
}
