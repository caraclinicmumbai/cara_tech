// Report 11: Appointments (spec §3, 3.11) — read from the calendar itself.

import { appointmentsReport } from "@/lib/reports/appointments";
import type { DateRange } from "@/lib/reports/range";
import { pct } from "@/lib/reports/shared";
import { Bars, Caveat, Empty, Num, Panel, Table, Tile } from "@/components/ReportUI";

const SOURCE_LABELS: Record<string, string> = {
  front_desk: "Front desk",
  call_centre: "Call centre",
  online: "Online",
  walk_in: "Walk-in",
  series: "Treatment plan",
  import: "Imported",
};

const mins = (m: number | null) => (m == null ? "—" : `${Math.round(m)} min`);

export async function AppointmentsSection({ range }: { range: DateRange }) {
  const r = await appointmentsReport(range);

  return (
    <div className="space-y-5">
      <Caveat>
        Appointments that <strong className="font-medium">start</strong> in this range. A no-show is
        counted against the patients who came (checked in or later); cancellations aren&rsquo;t no-shows,
        and late ones — inside the type&rsquo;s self-service cut-off — are shown on their own. Room
        utilisation is booked hours over the branch&rsquo;s open hours, holidays taken out.
      </Caveat>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Appointments" value={r.totals.booked.toLocaleString("en-IN")} hint={`${r.totals.attended} came`} />
        <Tile
          label="No-show rate"
          value={pct(r.totals.noShowPct)}
          hint={`${r.totals.noShows} no-show${r.totals.noShows === 1 ? "" : "s"}`}
          tone={r.totals.noShowPct != null && r.totals.noShowPct > 15 ? "warning" : undefined}
        />
        <Tile label="Cancelled" value={r.totals.cancelled} hint={`${r.totals.lateCancels} inside the cut-off`} />
        <Tile
          label="Wait after check-in"
          value={mins(r.wait.medianMin)}
          hint={r.wait.measured ? `median · 90% within ${mins(r.wait.p90Min)}` : "no visits with both times yet"}
          tone={r.wait.medianMin != null && r.wait.medianMin > 20 ? "warning" : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="No-shows by branch">
          <Bars
            items={r.noShowByBranch.map((b) => ({ label: b.branch, value: b.noShows, sub: `${pct(b.pct)} of ${b.attended + b.noShows}` }))}
            emptyText="No appointments in this range."
          />
        </Panel>
        <Panel title="No-shows by appointment type">
          <Bars
            items={r.noShowByType.map((t) => ({ label: t.type, value: t.noShows, sub: `${pct(t.pct)} of ${t.attended + t.noShows}` }))}
            emptyText="No appointments in this range."
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Room utilisation" hint="Booked hours ÷ open hours. An empty room is the finding.">
          {r.rooms.length === 0 ? (
            <Empty>No rooms set up yet.</Empty>
          ) : (
            <Table head={["Room", "Branch", { label: "Booked h", align: "right" }, { label: "Open h", align: "right" }, { label: "Used", align: "right" }]}>
              {r.rooms.map((x) => (
                <tr key={x.id}>
                  <td className="text-cara-ink">{x.name}</td>
                  <td>{x.branch}</td>
                  <Num>{x.bookedHours}</Num>
                  <Num>{x.openHours}</Num>
                  <Num strong>{pct(x.pct)}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <Panel title="Doctors" hint="Booked hours and visits — procedures per doctor.">
          {r.doctors.length === 0 ? (
            <Empty>No doctors booked in this range.</Empty>
          ) : (
            <Table head={["Doctor", { label: "Booked h", align: "right" }, { label: "Visits", align: "right" }, { label: "Done", align: "right" }, { label: "No-show", align: "right" }]}>
              {r.doctors.map((d) => (
                <tr key={d.id}>
                  <td className="text-cara-ink">{d.name}</td>
                  <Num>{d.bookedHours}</Num>
                  <Num>{d.visits}</Num>
                  <Num strong>{d.completed}</Num>
                  <Num>{d.noShows}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recall compliance" hint="Treatment-plan sessions whose window closed in this range.">
          {r.recall.due === 0 ? (
            <Empty>No plan sessions fell due in this range.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Tile label="Done in window" value={pct(r.recall.pct)} hint={`${r.recall.doneInWindow} of ${r.recall.due}`} tone={r.recall.pct != null && r.recall.pct < 70 ? "warning" : "good"} />
              <Tile label="Missed / late" value={r.recall.missed + r.recall.doneLate} hint={`${r.recall.missed} not done · ${r.recall.doneLate} done late`} />
            </div>
          )}
        </Panel>
        <Panel title="Booking lead time" hint="From the booking being made to the appointment, median.">
          {r.leadTime.length === 0 ? (
            <Empty>Nothing booked.</Empty>
          ) : (
            <Table head={["Booked via", { label: "Bookings", align: "right" }, { label: "Median days ahead", align: "right" }]}>
              {r.leadTime.map((l) => (
                <tr key={l.source}>
                  <td className="text-cara-ink">{SOURCE_LABELS[l.source] ?? l.source}</td>
                  <Num>{l.bookings}</Num>
                  <Num strong>{l.medianDays ?? "—"}</Num>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>

      <Panel title="Source → appointment" hint="Leads that arrived in this range: how many booked, how many actually came. This is what campaign ROI should divide by.">
        {r.conversion.length === 0 ? (
          <Empty>No leads arrived in this range.</Empty>
        ) : (
          <Table
            head={["Source", "Campaign", { label: "Leads", align: "right" }, { label: "Booked", align: "right" }, { label: "Came", align: "right" }, { label: "Lead → came", align: "right" }]}
          >
            {r.conversion.map((c) => (
              <tr key={`${c.source}|${c.campaign ?? ""}`}>
                <td className="text-cara-ink">{c.label}</td>
                <td>{c.campaign ?? "—"}</td>
                <Num>{c.leads}</Num>
                <Num>{c.booked}</Num>
                <Num>{c.attended}</Num>
                <Num strong>{pct(c.attendedPct)}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}
