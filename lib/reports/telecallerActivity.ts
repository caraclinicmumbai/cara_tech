// Telecaller Activity (§reports 14): when each telecaller was active, when they weren't, and
// the ratio between the two.
//
// Active means the CRM was open on their computer (RepActivitySession, from the header's
// heartbeat) or they were on a call, wherever they were sitting. A stretch they marked as a
// Break doesn't count, even with the tab open, unless they took a call during it. The status
// pill isn't used otherwise: someone auto-set Offline stays Offline until they tap it, however
// hard they're working.
//
// The CRM has no shift roster, so a person's day runs from their first activity to their last,
// inside the calling window (10:00–22:00 IST by default). Inactive periods are the gaps in
// between, which keeps an 8-hour shift from reading as 4 hours inactive. A late start or early
// finish shows in the First and Last columns instead. A day with no activity at all is counted
// apart: it may be a day off, and nothing here can tell.
//
// Gaps under five minutes are ignored: they're a tab reload or a dropped heartbeat.
import { prisma } from "@/lib/prisma";
import { permittedWindow } from "@/lib/callWindow";
import { availabilityLabel } from "@/lib/presenceStatus";
import { daysBetween, type DateRange } from "@/lib/reports/range";
import { rate } from "@/lib/reports/shared";

export const MIN_GAP_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export type Interval = { start: number; end: number };

/// Sorted, non-overlapping. Intervals closer than `bridge` become one.
export function mergeIntervals(list: Interval[], bridge = 0): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end + bridge) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function clip(list: Interval[], w: Interval): Interval[] {
  return list
    .map((i) => ({ start: Math.max(i.start, w.start), end: Math.min(i.end, w.end) }))
    .filter((i) => i.end > i.start);
}

export function subtractIntervals(list: Interval[], remove: Interval[]): Interval[] {
  let out = mergeIntervals(list);
  for (const r of mergeIntervals(remove)) {
    out = out.flatMap((i) => {
      if (r.end <= i.start || r.start >= i.end) return [i];
      return [
        ...(r.start > i.start ? [{ start: i.start, end: r.start }] : []),
        ...(r.end < i.end ? [{ start: r.end, end: i.end }] : []),
      ];
    });
  }
  return out;
}

const overlap = (a: Interval, list: Interval[]) =>
  list.reduce((sum, b) => sum + Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)), 0);

export type InactivePeriod = Interval & { kind: "break" | "inactive" };

export type ActivityDay = {
  day: string;
  first: number | null;
  last: number | null;
  active: Interval[];
  activeMs: number;
  inactiveMs: number;
  periods: InactivePeriod[];
};

/// One person's one day, from the raw stretches. Pure, so the arithmetic can be tested.
export function activityForDay(
  day: string,
  input: { sessions: Interval[]; calls: Interval[]; breaks: Interval[] },
  now: number = Date.now(),
): ActivityDay {
  const w = permittedWindow(day);
  const window: Interval = { start: w.start.getTime(), end: Math.min(w.end.getTime(), now) };
  const breaks = clip(input.breaks, window);
  const active = mergeIntervals(
    [...subtractIntervals(clip(input.sessions, window), breaks), ...clip(input.calls, window)],
    MIN_GAP_MS,
  );
  if (active.length === 0) {
    return { day, first: null, last: null, active: [], activeMs: 0, inactiveMs: 0, periods: [] };
  }
  const periods: InactivePeriod[] = [];
  for (let i = 1; i < active.length; i++) {
    const gap = { start: active[i - 1].end, end: active[i].start };
    const onBreak = overlap(gap, breaks) * 2 >= gap.end - gap.start;
    periods.push({ ...gap, kind: onBreak ? "break" : "inactive" });
  }
  return {
    day,
    first: active[0].start,
    last: active[active.length - 1].end,
    active,
    activeMs: active.reduce((sum, i) => sum + i.end - i.start, 0),
    inactiveMs: periods.reduce((sum, p) => sum + p.end - p.start, 0),
    periods,
  };
}

export type ActivityRep = {
  repId: string;
  repName: string;
  team: string;
  daysActive: number;
  /// Days since recording began with no activity at all. May be days off.
  daysNoActivity: number;
  activeMs: number;
  inactiveMs: number;
  activePct: number | null;
  days: ActivityDay[];
};

export type ActivityReport = {
  reps: ActivityRep[];
  /// When the CRM began recording activity. Days before this can't be reported.
  recordingSince: Date | null;
};

export async function telecallerActivity(range: DateRange, opts: { now?: Date } = {}): Promise<ActivityReport> {
  const now = (opts.now ?? new Date()).getTime();
  const [reps, firstSession] = await Promise.all([
    prisma.salesRep.findMany({
      where: { deletedAt: null, salesHead: false },
      select: { id: true, name: true, team: true, active: true, user: { select: { id: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.repActivitySession.findFirst({ orderBy: { startedAt: "asc" }, select: { startedAt: true } }),
  ]);
  const ids = reps.map((r) => r.id);
  const [sessions, calls, presence] = await Promise.all([
    prisma.repActivitySession.findMany({
      where: { repId: { in: ids }, startedAt: { lt: range.end }, lastSeenAt: { gt: range.start } },
      select: { repId: true, startedAt: true, lastSeenAt: true },
    }),
    prisma.call.findMany({
      // A call that began late the night before can run into this range.
      where: {
        handledById: { in: ids },
        createdAt: { gte: new Date(range.start.getTime() - DAY_MS), lt: range.end },
        duration: { gt: 0 },
      },
      select: { handledById: true, createdAt: true, duration: true },
    }),
    // A week back, so a Break that was already running when the range began is seen starting.
    prisma.auditLog.findMany({
      where: {
        action: { in: ["presence.change", "presence.auto"] },
        entityType: "rep",
        entityId: { in: ids },
        at: { gte: new Date(range.start.getTime() - 7 * DAY_MS), lt: range.end },
      },
      orderBy: { at: "asc" },
      select: { entityId: true, at: true, newValue: true },
    }),
  ]);

  const breakLabel = availabilityLabel("break");
  const firstDayRecorded = firstSession ? firstSession.startedAt.getTime() : null;

  const rows: ActivityRep[] = reps.map((rep) => {
    const mySessions = sessions
      .filter((s) => s.repId === rep.id)
      .map((s) => ({ start: s.startedAt.getTime(), end: s.lastSeenAt.getTime() }));
    const myCalls = calls
      .filter((c) => c.handledById === rep.id)
      .map((c) => ({ start: c.createdAt.getTime(), end: c.createdAt.getTime() + c.duration! * 1000 }));
    const events = presence.filter((e) => e.entityId === rep.id);
    const myBreaks: Interval[] = [];
    events.forEach((e, i) => {
      if (e.newValue !== breakLabel) return;
      const next = events[i + 1];
      myBreaks.push({ start: e.at.getTime(), end: next ? next.at.getTime() : now });
    });

    const days = daysBetween(range.fromDay, range.toDay)
      .filter((day) => permittedWindow(day).start.getTime() <= now)
      .map((day) => activityForDay(day, { sessions: mySessions, calls: myCalls, breaks: myBreaks }, now));
    const worked = days.filter((d) => d.first != null);
    const activeMs = worked.reduce((sum, d) => sum + d.activeMs, 0);
    const inactiveMs = worked.reduce((sum, d) => sum + d.inactiveMs, 0);
    return {
      repId: rep.id,
      repName: rep.name,
      team: rep.team,
      daysActive: worked.length,
      daysNoActivity:
        firstDayRecorded == null
          ? 0
          : days.filter((d) => d.first == null && permittedWindow(d.day).end.getTime() > firstDayRecorded).length,
      activeMs,
      inactiveMs,
      activePct: rate(activeMs, activeMs + inactiveMs),
      days: worked.reverse(),
    };
  });

  const lineStaff = new Set(reps.filter((r) => r.active && r.user).map((r) => r.id));
  return {
    reps: rows
      .filter((r) => r.daysActive > 0 || lineStaff.has(r.repId))
      .sort((a, b) => b.activeMs - a.activeMs || a.repName.localeCompare(b.repName)),
    recordingSince: firstSession?.startedAt ?? null,
  };
}
