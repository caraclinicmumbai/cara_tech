// Follow-Up Tracking (§reports 15): which LEADS each telecaller still has to follow up.
// A live picture, not a history over a date range: a follow-up done late stops counting
// the moment it's done.
//
// Counted per lead, never per follow-up step. A lead can carry several follow-ups (the
// old six-step ladder did, and staff can now add more), and counting steps listed the
// same patient three times and inflated every number. A lead's status comes from its
// SOONEST pending follow-up:
//
//   Missed today    due earlier today, still not done
//   Overdue         due before today, still not done
//   Due later today due between now and midnight
//   Carried over    overdue, on a lead brought over from the previous CRM. Kept apart
//                   because that backlog arrived already late and would bury the real number.
//
// Lost leads are left out, as the follow-up reminders leave them out: a follow-up on a lead
// marked lost isn't work anyone is expected to do.
import { prisma } from "@/lib/prisma";
import { addDays, istDayStart, istToday } from "@/lib/reports/range";
import { isConnectedCall } from "@/lib/callList";

export type FollowUpStatus = "missed_today" | "overdue" | "due_later_today" | "carried_over";

export type FollowUpLead = {
  leadId: string;
  leadName: string;
  repId: string;
  status: FollowUpStatus;
  /// The soonest pending follow-up — the one that sets the status.
  next: { title: string; dueAt: Date };
  /// Every other pending follow-up on the lead, soonest first (including later dates).
  others: { title: string; dueAt: Date }[];
  lastCall: { at: Date; connected: boolean } | null;
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
  /// Counts of unique leads.
  totals: { missedToday: number; overdue: number; carriedOver: number; dueLaterToday: number };
  /// One row per lead (carried-over leads aren't listed, only counted), in working order:
  /// missed today, then overdue (most recently missed first), then due later today.
  leads: FollowUpLead[];
  /// Leads beyond the list's length: counted above, not listed.
  leadsNotListed: number;
};

const LIST_MAX = 150;
const STATUS_ORDER: FollowUpStatus[] = ["missed_today", "overdue", "due_later_today"];

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
        lead: { deletedAt: null, stage: { not: "lost" } },
        ...(opts.repId ? { ownerRepId: opts.repId } : { ownerRepId: { not: null } }),
      },
      // Soonest first, so the first row seen for a lead is the one that decides it.
      orderBy: { dueAt: "asc" },
      select: {
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

  // One entry per lead: its soonest pending follow-up and who owns it.
  const byLead = new Map<string, FollowUpLead>();
  for (const s of steps) {
    if (byLead.has(s.lead.id)) continue;
    const dueAt = s.dueAt!;
    const status: FollowUpStatus =
      dueAt >= now
        ? "due_later_today"
        : dueAt >= todayStart
          ? "missed_today"
          : s.lead.externalId?.startsWith("legacy:")
            ? "carried_over"
            : "overdue";
    byLead.set(s.lead.id, {
      leadId: s.lead.id,
      leadName: s.lead.name,
      repId: s.ownerRepId!,
      status,
      next: { title: s.title, dueAt },
      others: [],
      lastCall: null,
    });
  }

  const counts = new Map<string, Omit<FollowUpRep, "repId" | "repName">>();
  const tally = (repId: string) => {
    let c = counts.get(repId);
    if (!c) counts.set(repId, (c = { missedToday: 0, overdue: 0, carriedOver: 0, dueLaterToday: 0 }));
    return c;
  };
  for (const l of byLead.values()) {
    const c = tally(l.repId);
    if (l.status === "missed_today") c.missedToday++;
    else if (l.status === "overdue") c.overdue++;
    else if (l.status === "carried_over") c.carriedOver++;
    else c.dueLaterToday++;
  }

  const listable = [...byLead.values()]
    .filter((l) => l.status !== "carried_over")
    .sort((a, b) => {
      const g = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
      if (g) return g;
      // Overdue: most recently missed first. Today's: in the order they fall due.
      const t = a.next.dueAt.getTime() - b.next.dueAt.getTime();
      return a.status === "overdue" ? -t : t;
    });
  const leads = listable.slice(0, LIST_MAX);

  // The rest of each listed lead's follow-ups, and its last call.
  if (leads.length) {
    const ids = leads.map((l) => l.leadId);
    const [pending, calls] = await Promise.all([
      prisma.leadFollowUpStep.findMany({
        where: { leadId: { in: ids }, status: "pending", dueAt: { not: null } },
        orderBy: { dueAt: "asc" },
        select: { leadId: true, title: true, dueAt: true },
      }),
      prisma.call.findMany({
        where: { leadId: { in: ids } },
        distinct: ["leadId"],
        orderBy: [{ leadId: "asc" }, { createdAt: "desc" }],
        select: { leadId: true, createdAt: true, outcome: true, duration: true },
      }),
    ]);
    const byId = new Map(leads.map((l) => [l.leadId, l]));
    for (const p of pending) {
      const l = byId.get(p.leadId)!;
      if (p.dueAt!.getTime() === l.next.dueAt.getTime() && p.title === l.next.title) continue;
      l.others.push({ title: p.title, dueAt: p.dueAt! });
    }
    for (const c of calls) byId.get(c.leadId)!.lastCall = { at: c.createdAt, connected: isConnectedCall(c) };
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
    leads,
    leadsNotListed: listable.length - leads.length,
  };
}
