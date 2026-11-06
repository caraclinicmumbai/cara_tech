// Speed to Call (§reports 13): how long a new lead waited for a person to call them, and
// whether that was inside the clinic's five-minute target.
//
// The clock starts when the lead arrives, or at the next opening of the calling window (10:00
// IST by default) if it arrived overnight: nobody can be asked to phone a patient at 2 am. It
// stops at the first call by a person, connected or not, because the target measures how fast
// someone tried. AI calls don't stop it.
//
// Left out, because there is nothing to be quick about: patients who rang us (inbound_call),
// walk-ins, leads merged into another, and leads brought over from the previous CRM.
//
// A lead's result is credited to whoever made the first call. Until someone does, it sits
// with the lead's owner.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { nextPermittedTime } from "@/lib/callWindow";
import { isConnectedCall } from "@/lib/callList";
import { HUMAN_CALL } from "@/lib/reports/telecalling";
import type { DateRange } from "@/lib/reports/range";
import { mean, median, rate } from "@/lib/reports/shared";

export const SPEED_TARGET_MS = 5 * 60_000;

export const SPEED_RESULTS = ["within", "late", "not_called", "waiting"] as const;
export type SpeedResult = (typeof SPEED_RESULTS)[number];
export const SPEED_RESULT_LABELS: Record<SpeedResult, string> = {
  within: "Within 5 min",
  late: "Over 5 min",
  not_called: "Not called",
  waiting: "Still within 5 min",
};

export function isSpeedResult(v: string | undefined): v is SpeedResult {
  return (SPEED_RESULTS as readonly string[]).includes(v ?? "");
}

const NOT_A_RACE = ["inbound_call", "walk_in"];

/// When the clock starts, how long the wait was, and how it scored. `asOf` is the moment being
/// reported from: a call after it hasn't happened yet.
export function scoreSpeed(
  createdAt: Date,
  firstCallAt: Date | null,
  asOf: Date,
): { clockStart: Date; tatMs: number | null; result: SpeedResult } {
  const clockStart = nextPermittedTime(createdAt);
  if (firstCallAt && firstCallAt <= asOf) {
    // Someone rang before the window opened: that is a wait of nothing, not a negative one.
    const tatMs = Math.max(0, firstCallAt.getTime() - clockStart.getTime());
    return { clockStart, tatMs, result: tatMs <= SPEED_TARGET_MS ? "within" : "late" };
  }
  const waited = asOf.getTime() - clockStart.getTime();
  return { clockStart, tatMs: null, result: waited <= SPEED_TARGET_MS ? "waiting" : "not_called" };
}

export type SpeedRecord = {
  leadId: string;
  leadName: string;
  source: string | null;
  arrivedAt: Date;
  clockStart: Date;
  firstCallAt: Date | null;
  tatMs: number | null;
  result: SpeedResult;
  connected: boolean | null;
  repId: string | null;
  repName: string | null;
};

export type SpeedCounts = {
  leads: number;
  within: number;
  late: number;
  notCalled: number;
  waiting: number;
  /// Of the leads whose result is settled. A lead still inside its five minutes isn't a miss yet.
  withinPct: number | null;
  medianMs: number | null;
  meanMs: number | null;
};

export type SpeedRep = SpeedCounts & { repId: string | null; repName: string };

export type SpeedReport = { totals: SpeedCounts; reps: SpeedRep[]; records: SpeedRecord[] };

function countUp(records: SpeedRecord[]): SpeedCounts {
  const n = (r: SpeedResult) => records.filter((x) => x.result === r).length;
  const within = n("within");
  const late = n("late");
  const notCalled = n("not_called");
  const tats = records.map((r) => r.tatMs).filter((v): v is number => v != null);
  return {
    leads: records.length,
    within,
    late,
    notCalled,
    waiting: n("waiting"),
    withinPct: rate(within, within + late + notCalled),
    medianMs: median(tats),
    meanMs: mean(tats),
  };
}

export async function speedToCall(
  range: DateRange,
  opts: { repId?: string; asOf?: Date } = {},
): Promise<SpeedReport> {
  const asOf = opts.asOf ?? new Date();
  // Spelt out with both sides of the NULL: `notIn` alone would drop a lead with no source.
  const where: Prisma.LeadWhereInput = {
    createdAt: { gte: range.start, lt: range.end },
    deletedAt: null,
    duplicateOfId: null,
    AND: [
      { OR: [{ source: null }, { source: { notIn: NOT_A_RACE } }] },
      { OR: [{ externalId: null }, { NOT: { externalId: { startsWith: "legacy:" } } }] },
    ],
  };

  const leads = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      source: true,
      createdAt: true,
      assignedRepId: true,
      assignedRep: { select: { name: true } },
      calls: {
        where: HUMAN_CALL,
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          outcome: true,
          duration: true,
          handledById: true,
          handledBy: { select: { name: true } },
        },
      },
    },
  });

  let records: SpeedRecord[] = leads.map((l) => {
    // After arrival only: merging leads can bring along calls older than the lead they land on.
    const call = l.calls.find((c) => c.createdAt >= l.createdAt && c.createdAt <= asOf) ?? null;
    const { clockStart, tatMs, result } = scoreSpeed(l.createdAt, call?.createdAt ?? null, asOf);
    return {
      leadId: l.id,
      leadName: l.name,
      source: l.source,
      arrivedAt: l.createdAt,
      clockStart,
      firstCallAt: call?.createdAt ?? null,
      tatMs,
      result,
      connected: call ? isConnectedCall(call) : null,
      repId: call?.handledById ?? l.assignedRepId,
      repName: call?.handledBy?.name ?? l.assignedRep?.name ?? null,
    };
  });
  if (opts.repId) records = records.filter((r) => r.repId === opts.repId);

  const groups = new Map<string, SpeedRecord[]>();
  for (const r of records) {
    const key = r.repId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const reps: SpeedRep[] = [...groups.entries()]
    .map(([key, list]) => ({
      ...countUp(list),
      repId: key || null,
      repName: list[0].repName ?? "No owner",
    }))
    .sort((a, b) => b.leads - a.leads || a.repName.localeCompare(b.repName));

  return { totals: countUp(records), reps, records };
}
