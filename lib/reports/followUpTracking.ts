// Follow-Up Tracking (§reports 15): for each telecaller, what they missed today and what is
// overdue. This is a live picture of the steps still pending, not a history over a date range:
// a follow-up done late stops counting the moment it's done.
//
//   Missed today  due earlier today, still not done
//   Overdue       due before today, still not done
//   Carried over  overdue, on a lead brought over from the previous CRM. Kept apart because
//                 that backlog arrived already late, and would otherwise bury the real number.
import { prisma } from "@/lib/prisma";
import { addDays, istDayStart, istToday } from "@/lib/reports/range";

export type FollowUpItem = {
  id: string;
  leadId: string;
  leadName: string;
  title: string;
  dueAt: Date;
  repId: string | null;
};

export type FollowUpRep = {
  repId: string;
  repName: string;
  missedToday: number;
  overdue: number;
  carriedOver: number;
  dueLaterToday: number;
};

export type FollowUpReport = {
  reps: FollowUpRep[];
  totals: { missedToday: number; overdue: number; carriedOver: number; dueLaterToday: number };
  missedToday: FollowUpItem[];
  overdue: FollowUpItem[];
  /// Overdue rows beyond the list's length: counted above, not listed.
  overdueNotListed: number;
};

const OVERDUE_LIST_MAX = 100;

export async function followUpTracking(opts: { repId?: string; now?: Date } = {}): Promise<FollowUpReport> {
  const now = opts.now ?? new Date();
  const todayStart = istDayStart(istToday(now));
  const tomorrowStart = istDayStart(addDays(istToday(now), 1));

  const [steps, reps] = await Promise.all([
    prisma.leadFollowUpStep.findMany({
      where: {
        status: "pending",
        ownerKind: "rep",
        dueAt: { lt: tomorrowStart },
        lead: { deletedAt: null },
        ...(opts.repId ? { ownerRepId: opts.repId } : { ownerRepId: { not: null } }),
      },
      orderBy: { dueAt: "desc" },
      select: {
        id: true,
        title: true,
        dueAt: true,
        ownerRepId: true,
        lead: { select: { id: true, name: true, externalId: true } },
      },
    }),
    prisma.salesRep.findMany({
      where: opts.repId ? { id: opts.repId } : { deletedAt: null, salesHead: false },
      select: { id: true, name: true, active: true, user: { select: { id: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const counts = new Map<string, Omit<FollowUpRep, "repId" | "repName">>();
  const tally = (repId: string) => {
    let c = counts.get(repId);
    if (!c) counts.set(repId, (c = { missedToday: 0, overdue: 0, carriedOver: 0, dueLaterToday: 0 }));
    return c;
  };
  const missedToday: FollowUpItem[] = [];
  const overdue: FollowUpItem[] = [];

  for (const s of steps) {
    const dueAt = s.dueAt!;
    const c = tally(s.ownerRepId!);
    const item: FollowUpItem = {
      id: s.id,
      leadId: s.lead.id,
      leadName: s.lead.name,
      title: s.title,
      dueAt,
      repId: s.ownerRepId,
    };
    if (dueAt >= now) c.dueLaterToday++;
    else if (dueAt >= todayStart) {
      c.missedToday++;
      missedToday.push(item);
    } else if (s.lead.externalId?.startsWith("legacy:")) c.carriedOver++;
    else {
      c.overdue++;
      overdue.push(item);
    }
  }

  const rows: FollowUpRep[] = reps
    .filter((r) => counts.has(r.id) || (r.active && !!r.user) || r.id === opts.repId)
    .map((r) => ({
      repId: r.id,
      repName: r.name,
      ...(counts.get(r.id) ?? { missedToday: 0, overdue: 0, carriedOver: 0, dueLaterToday: 0 }),
    }))
    .sort((a, b) => b.missedToday + b.overdue - (a.missedToday + a.overdue) || a.repName.localeCompare(b.repName));

  const sum = (pick: (r: FollowUpRep) => number) => rows.reduce((a, r) => a + pick(r), 0);
  return {
    reps: rows,
    totals: {
      missedToday: sum((r) => r.missedToday),
      overdue: sum((r) => r.overdue),
      carriedOver: sum((r) => r.carriedOver),
      dueLaterToday: sum((r) => r.dueLaterToday),
    },
    missedToday,
    overdue: overdue.slice(0, OVERDUE_LIST_MAX),
    overdueNotListed: Math.max(0, overdue.length - OVERDUE_LIST_MAX),
  };
}
