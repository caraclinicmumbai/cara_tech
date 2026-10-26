// Appointments report (spec §3, row 3.11) — the first report that reads the calendar
// itself rather than inferring visits from a lead's stage.
//
//   Utilisation      rooms: booked hours ÷ the branch's open hours; doctors: booked hours
//                    and visits (no roster-based % — most doctors have no roster yet).
//   No-show rate     no-shows ÷ (no-shows + patients who came), by branch and type.
//                    Late cancellations (inside the type's cut-off) are shown beside it.
//   Wait time        check-in → start of the visit, median and 90th percentile.
//   Recall           treatment-plan sessions whose window closed in the range: done
//                    inside the window ÷ due.
//   Lead time        booking made → appointment, median days, by booking source.
//   Conversion       leads that arrived in the range, by source and campaign: how many
//                    booked an appointment, how many attended.
//
// Appointments are counted by their START in the range (IST days, half-open).
import { prisma } from "@/lib/prisma";
import type { DateRange } from "@/lib/reports/range";
import { daysBetween } from "@/lib/reports/range";
import { branchDay } from "@/lib/scheduling/hours";
import { sourceLabel } from "@/lib/reports/shared";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const CAME = ["checked_in", "in_progress", "completed"];

export type AppointmentsReport = {
  totals: { booked: number; attended: number; noShows: number; cancelled: number; lateCancels: number; noShowPct: number | null };
  noShowByBranch: { branch: string; attended: number; noShows: number; pct: number | null }[];
  noShowByType: { type: string; attended: number; noShows: number; pct: number | null }[];
  rooms: { id: string; name: string; branch: string; bookedHours: number; openHours: number; pct: number | null }[];
  doctors: { id: string; name: string; bookedHours: number; visits: number; completed: number; noShows: number }[];
  wait: { measured: number; medianMin: number | null; p90Min: number | null; lateArrivals: number };
  recall: { due: number; doneInWindow: number; doneLate: number; missed: number; pct: number | null };
  leadTime: { source: string; bookings: number; medianDays: number | null }[];
  conversion: { source: string; label: string; campaign: string | null; leads: number; booked: number; attended: number; bookedPct: number | null; attendedPct: number | null }[];
};

const rate = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export async function appointmentsReport(range: DateRange): Promise<AppointmentsReport> {
  const within = { gte: range.start, lt: range.end };
  const [appts, leads, steps] = await Promise.all([
    prisma.appointment.findMany({
      where: { startAt: within, status: { notIn: ["rescheduled", "tentative"] } },
      select: {
        status: true,
        source: true,
        startAt: true,
        endAt: true,
        createdAt: true,
        checkedInAt: true,
        startedAt: true,
        cancelledAt: true,
        branchId: true,
        branch: { select: { name: true } },
        type: { select: { name: true, selfServiceCutoffHours: true } },
        resources: { select: { resource: { select: { id: true, name: true, kind: true, branchId: true } } } },
      },
    }),
    prisma.lead.findMany({
      where: { createdAt: within, deletedAt: null },
      select: {
        source: true,
        campaign: true,
        appointments: { where: { status: { notIn: ["tentative"] } }, select: { status: true } },
      },
    }),
    prisma.plannedStep.findMany({
      where: { dueTo: within, status: { not: "waived" } },
      select: { status: true, dueFrom: true, dueTo: true, appointment: { select: { status: true, startAt: true } } },
    }),
  ]);

  // ── No-shows ──
  let attended = 0;
  let noShows = 0;
  let cancelled = 0;
  let lateCancels = 0;
  const byBranch = new Map<string, { attended: number; noShows: number }>();
  const byType = new Map<string, { attended: number; noShows: number }>();
  const bump = (m: Map<string, { attended: number; noShows: number }>, k: string, came: boolean) => {
    const g = m.get(k) ?? { attended: 0, noShows: 0 };
    if (came) g.attended++;
    else g.noShows++;
    m.set(k, g);
  };
  for (const a of appts) {
    if (CAME.includes(a.status)) {
      attended++;
      bump(byBranch, a.branch.name, true);
      bump(byType, a.type.name, true);
    } else if (a.status === "no_show") {
      noShows++;
      bump(byBranch, a.branch.name, false);
      bump(byType, a.type.name, false);
    } else if (a.status === "cancelled") {
      cancelled++;
      if (a.cancelledAt && a.startAt.getTime() - a.cancelledAt.getTime() < a.type.selfServiceCutoffHours * HOUR) lateCancels++;
    }
  }
  const asRows = <K extends string>(m: Map<string, { attended: number; noShows: number }>, key: K) =>
    [...m.entries()]
      .map(([k, g]) => ({ [key]: k, attended: g.attended, noShows: g.noShows, pct: rate(g.noShows, g.attended + g.noShows) }) as { [P in K]: string } & { attended: number; noShows: number; pct: number | null })
      .sort((a, b) => b.noShows - a.noShows || b.attended - a.attended);

  // ── Utilisation ──
  const live = appts.filter((a) => a.status !== "cancelled");
  const roomHours = new Map<string, { name: string; branchId: string; hours: number }>();
  const docs = new Map<string, { name: string; hours: number; visits: number; completed: number; noShows: number }>();
  for (const a of live) {
    const h = (a.endAt.getTime() - a.startAt.getTime()) / HOUR;
    for (const { resource: r } of a.resources) {
      if (r.kind === "room") {
        const g = roomHours.get(r.id) ?? { name: r.name, branchId: r.branchId ?? a.branchId, hours: 0 };
        g.hours += h;
        roomHours.set(r.id, g);
      } else if (r.kind === "doctor") {
        const g = docs.get(r.id) ?? { name: r.name, hours: 0, visits: 0, completed: 0, noShows: 0 };
        g.hours += h;
        g.visits++;
        if (a.status === "completed") g.completed++;
        if (a.status === "no_show") g.noShows++;
        docs.set(r.id, g);
      }
    }
  }
  // Every active room counts, booked or not: an empty room is the finding.
  const allRooms = await prisma.resource.findMany({
    where: { kind: "room", active: true, branchId: { not: null } },
    select: { id: true, name: true, branchId: true, branch: { select: { name: true } } },
  });
  const days = daysBetween(range.fromDay, range.toDay);
  const openHoursByBranch = new Map<string, number>();
  for (const branchId of new Set(allRooms.map((r) => r.branchId!))) {
    let mins = 0;
    for (const day of days) {
      const d = await branchDay(prisma, branchId, day);
      const open = d.open.reduce((s, w) => s + (w.endMin - w.startMin), 0);
      const shut = d.closures.reduce((s, c) => s + (c.endMin - c.startMin), 0);
      mins += Math.max(0, open - shut);
    }
    openHoursByBranch.set(branchId, mins / 60);
  }
  const rooms = allRooms
    .map((r) => {
      const booked = roomHours.get(r.id)?.hours ?? 0;
      const open = openHoursByBranch.get(r.branchId!) ?? 0;
      return { id: r.id, name: r.name, branch: r.branch?.name ?? "—", bookedHours: round1(booked), openHours: round1(open), pct: rate(booked, open) };
    })
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  const doctors = [...docs.entries()]
    .map(([id, g]) => ({ id, name: g.name, bookedHours: round1(g.hours), visits: g.visits, completed: g.completed, noShows: g.noShows }))
    .sort((a, b) => b.bookedHours - a.bookedHours);

  // ── Wait time ──
  const waits = appts
    .filter((a) => a.checkedInAt && a.startedAt && a.startedAt > a.checkedInAt)
    .map((a) => (a.startedAt!.getTime() - a.checkedInAt!.getTime()) / 60_000)
    .sort((x, y) => x - y);
  const lateArrivals = appts.filter((a) => a.checkedInAt && a.checkedInAt.getTime() - a.startAt.getTime() > 10 * 60_000).length;

  // ── Recall compliance ──
  let doneInWindow = 0;
  let doneLate = 0;
  for (const s of steps) {
    if (s.status !== "completed") continue;
    const at = s.appointment?.startAt;
    if (at && at >= s.dueFrom && at < s.dueTo) doneInWindow++;
    else doneLate++;
  }
  const missed = steps.filter((s) => s.status !== "completed").length;

  // ── Booking lead time ──
  const bySource = new Map<string, number[]>();
  for (const a of appts) {
    const d = (a.startAt.getTime() - a.createdAt.getTime()) / DAY;
    if (d < 0) continue;
    const list = bySource.get(a.source) ?? [];
    list.push(d);
    bySource.set(a.source, list);
  }
  const leadTime = [...bySource.entries()]
    .map(([source, list]) => {
      list.sort((x, y) => x - y);
      const m = quantile(list, 0.5);
      return { source, bookings: list.length, medianDays: m == null ? null : round1(m) };
    })
    .sort((a, b) => b.bookings - a.bookings);

  // ── Source / campaign → appointment ──
  const conv = new Map<string, { source: string; campaign: string | null; leads: number; booked: number; attended: number }>();
  for (const l of leads) {
    const source = l.source ?? "unknown";
    const key = `${source}|${l.campaign ?? ""}`;
    const g = conv.get(key) ?? { source, campaign: l.campaign, leads: 0, booked: 0, attended: 0 };
    g.leads++;
    if (l.appointments.length > 0) g.booked++;
    if (l.appointments.some((a) => CAME.includes(a.status))) g.attended++;
    conv.set(key, g);
  }
  const conversion = [...conv.values()]
    .map((g) => ({ ...g, label: sourceLabel(g.source), bookedPct: rate(g.booked, g.leads), attendedPct: rate(g.attended, g.leads) }))
    .sort((a, b) => b.leads - a.leads);

  return {
    totals: { booked: appts.length, attended, noShows, cancelled, lateCancels, noShowPct: rate(noShows, attended + noShows) },
    noShowByBranch: asRows(byBranch, "branch"),
    noShowByType: asRows(byType, "type"),
    rooms,
    doctors,
    wait: { measured: waits.length, medianMin: quantile(waits, 0.5), p90Min: quantile(waits, 0.9), lateArrivals },
    recall: { due: steps.length, doneInWindow, doneLate, missed, pct: rate(doneInWindow, steps.length) },
    leadTime,
    conversion,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
