// Telecalling report (§reports 12): call volume, talk time, outcomes and the appointments
// telecallers booked, by day, week or month and by person.
//
// A telecalling call is one a person handled: a click-to-call, or a clinic-line call somebody
// picked up. AI calls have their own report. A clinic-line call nobody answered belongs to no
// telecaller, so it is counted beside the table rather than against anyone.
//
// Appointments are credited to the person who booked them, so only bookings made from a login
// linked to a sales rep count here. Booked is dated by when the booking was made; show-ups and
// no-shows by the appointment's own date. One day's row can therefore show more show-ups than
// bookings, and a rate never mixes the two.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isConnectedCall } from "@/lib/callList";
import { CAME } from "@/lib/reports/appointments";
import { addDays, daysBetween, istDay, istDayStart, type DateRange } from "@/lib/reports/range";
import { rate } from "@/lib/reports/shared";

export const BUCKETS = ["day", "week", "month"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_LABELS: Record<Bucket, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

export function isBucket(v: string | undefined): v is Bucket {
  return (BUCKETS as readonly string[]).includes(v ?? "");
}

/// Calls a person handled. `inbound` only gets a handler once someone really spoke
/// (lib/inboundCallLog.ts undoes it for a phone that merely picked up for a moment).
export const HUMAN_CALL: Prisma.CallWhereInput = {
  handledById: { not: null },
  callType: { in: ["human_handover", "inbound"] },
};

/// The first day of the bucket an IST day falls in. Weeks start on Monday.
export function bucketStart(day: string, by: Bucket): string {
  if (by === "day") return day;
  if (by === "month") return `${day.slice(0, 7)}-01`;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

function dayLabel(day: string, withYear = false): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(istDayStart(day));
}

function bucketLabel(firstDay: string, lastDay: string, by: Bucket): string {
  if (by === "day") {
    const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short" }).format(
      istDayStart(firstDay),
    );
    return `${weekday} ${dayLabel(firstDay)}`;
  }
  if (by === "month") {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "long", year: "numeric" }).format(
      istDayStart(firstDay),
    );
  }
  return `${dayLabel(firstDay)} – ${dayLabel(lastDay)}`;
}

export type TelecallingCounts = {
  calls: number;
  outbound: number;
  inbound: number;
  connected: number;
  notConnected: number;
  connectPct: number | null;
  talkSeconds: number;
  /// Average length of a connected call whose duration the phone provider reported.
  avgSeconds: number | null;
  booked: number;
  showed: number;
  noShows: number;
  showPct: number | null;
};

export type TelecallingBucket = TelecallingCounts & { key: string; label: string; fromDay: string; toDay: string };
export type TelecallingRep = TelecallingCounts & { repId: string; repName: string; team: string; salesHead: boolean };

export type TelecallingReport = {
  buckets: TelecallingBucket[];
  reps: TelecallingRep[];
  totals: TelecallingCounts;
  /// Clinic-line calls nobody answered, which are nobody's row. Null on a one-person view.
  missedInbound: number | null;
};

type Tally = Omit<TelecallingCounts, "connectPct" | "avgSeconds" | "showPct"> & { timedCalls: number };

const emptyTally = (): Tally => ({
  calls: 0,
  outbound: 0,
  inbound: 0,
  connected: 0,
  notConnected: 0,
  talkSeconds: 0,
  timedCalls: 0,
  booked: 0,
  showed: 0,
  noShows: 0,
});

function finish(t: Tally): TelecallingCounts {
  const { timedCalls, ...counts } = t;
  return {
    ...counts,
    connectPct: rate(t.connected, t.calls),
    avgSeconds: timedCalls > 0 ? t.talkSeconds / timedCalls : null,
    showPct: rate(t.showed, t.showed + t.noShows),
  };
}

export async function telecallingReport(
  range: DateRange,
  by: Bucket = "day",
  repId?: string,
): Promise<TelecallingReport> {
  const window = { gte: range.start, lt: range.end };
  const inRange = (d: Date) => d >= range.start && d < range.end;

  const [reps, calls, appts, missedInbound] = await Promise.all([
    prisma.salesRep.findMany({
      where: repId ? { id: repId } : { deletedAt: null },
      select: { id: true, name: true, active: true, salesHead: true, team: true, user: { select: { id: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.call.findMany({
      where: { ...HUMAN_CALL, createdAt: window, ...(repId ? { handledById: repId } : {}) },
      select: { callType: true, outcome: true, duration: true, createdAt: true, handledById: true },
    }),
    prisma.appointment.findMany({
      where: {
        bookedBy: repId ? { salesRepId: repId } : { salesRepId: { not: null } },
        OR: [{ createdAt: window }, { startAt: window }],
      },
      select: {
        createdAt: true,
        startAt: true,
        status: true,
        rescheduledFromId: true,
        bookedBy: { select: { salesRepId: true } },
      },
    }),
    repId
      ? Promise.resolve(null)
      : prisma.call.count({
          where: {
            createdAt: window,
            OR: [{ callType: "inbound_voicemail" }, { callType: "inbound", outcome: { in: ["missed", "voicemail"] } }],
          },
        }),
  ]);

  // Every period in the range gets a row, including the empty ones: a day with no calls is a finding.
  const buckets = new Map<string, Tally & { fromDay: string; toDay: string }>();
  for (const day of daysBetween(range.fromDay, range.toDay)) {
    const key = bucketStart(day, by);
    const b = buckets.get(key);
    if (b) b.toDay = day;
    else buckets.set(key, { ...emptyTally(), fromDay: day, toDay: day });
  }
  const byRep = new Map<string, Tally>();
  const total = emptyTally();
  const repTally = (id: string) => {
    let t = byRep.get(id);
    if (!t) byRep.set(id, (t = emptyTally()));
    return t;
  };
  const tallies = (d: Date, rep: string | null | undefined) => {
    const bucket = buckets.get(bucketStart(istDay(d), by));
    return [total, ...(bucket ? [bucket] : []), ...(rep ? [repTally(rep)] : [])];
  };

  for (const c of calls) {
    const connected = isConnectedCall(c);
    for (const t of tallies(c.createdAt, c.handledById)) {
      t.calls++;
      if (c.callType === "inbound") t.inbound++;
      else t.outbound++;
      if (connected) t.connected++;
      else t.notConnected++;
      if (connected && (c.duration ?? 0) > 0) {
        t.talkSeconds += c.duration!;
        t.timedCalls++;
      }
    }
  }

  for (const a of appts) {
    const rep = a.bookedBy?.salesRepId;
    // A reschedule is the same booking moved, not a new one; a tentative hold isn't a booking yet.
    if (inRange(a.createdAt) && !a.rescheduledFromId && a.status !== "tentative") {
      for (const t of tallies(a.createdAt, rep)) t.booked++;
    }
    if (inRange(a.startAt)) {
      if (CAME.includes(a.status)) for (const t of tallies(a.startAt, rep)) t.showed++;
      else if (a.status === "no_show") for (const t of tallies(a.startAt, rep)) t.noShows++;
    }
  }

  const repRows: TelecallingRep[] = reps
    .filter((r) => {
      const t = byRep.get(r.id);
      const lineStaff = r.active && !!r.user && !r.salesHead;
      return lineStaff || (!!t && (t.calls > 0 || t.booked > 0 || t.showed > 0 || t.noShows > 0));
    })
    .map((r) => ({
      ...finish(byRep.get(r.id) ?? emptyTally()),
      repId: r.id,
      repName: r.name,
      team: r.team,
      salesHead: r.salesHead,
    }))
    .sort((a, b) => b.calls - a.calls || a.repName.localeCompare(b.repName));

  return {
    buckets: [...buckets.entries()].map(([key, b]) => ({
      ...finish(b),
      key,
      label: bucketLabel(b.fromDay, b.toDay, by),
      fromDay: b.fromDay,
      toDay: b.toDay,
    })),
    reps: repRows,
    totals: finish(total),
    missedInbound,
  };
}
