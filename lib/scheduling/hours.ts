// Branch opening hours and closures (§3.2 1.C) — "without it the system offers slots
// on Diwali". Turns the BranchHours / BranchClosure rows into the open windows and
// closures the engine reads for one IST day.
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Window } from "@/lib/scheduling/engine";
import { dateColumn, weekdayOfKey } from "@/lib/scheduling/time";

type Db = PrismaClient | Prisma.TransactionClient;

/// Hours a branch has before anyone configures it: 09:00–20:00, every day. Chosen so
/// a new branch is bookable on day one; set real hours on the Scheduling setup screen.
export const DEFAULT_OPEN_MIN = 9 * 60;
export const DEFAULT_CLOSE_MIN = 20 * 60;

export type WeekHours = { weekday: number; openMin: number; closeMin: number; closed: boolean }[];

export function defaultWeek(): WeekHours {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    openMin: DEFAULT_OPEN_MIN,
    closeMin: DEFAULT_CLOSE_MIN,
    closed: false,
  }));
}

/// The branch's full week — configured rows, or the default for a branch that has none.
export async function branchWeek(db: Db, branchId: string): Promise<{ week: WeekHours; configured: boolean }> {
  const rows = await db.branchHours.findMany({ where: { branchId }, orderBy: { weekday: "asc" } });
  if (rows.length === 0) return { week: defaultWeek(), configured: false };
  // A configured branch missing a weekday row treats that day as closed.
  const week = Array.from({ length: 7 }, (_, weekday) => {
    const r = rows.find((x) => x.weekday === weekday);
    return r
      ? { weekday, openMin: r.openMin, closeMin: r.closeMin, closed: r.closed }
      : { weekday, openMin: DEFAULT_OPEN_MIN, closeMin: DEFAULT_CLOSE_MIN, closed: true };
  });
  return { week, configured: true };
}

/// Open windows and closures for one branch on one IST day.
export async function branchDay(
  db: Db,
  branchId: string,
  dateKey: string,
): Promise<{ open: Window[]; closures: { startMin: number; endMin: number; reason: string }[] }> {
  const { week } = await branchWeek(db, branchId);
  const day = week[weekdayOfKey(dateKey)];
  const date = dateColumn(dateKey);
  const closureRows = await db.branchClosure.findMany({
    where: {
      OR: [{ branchId }, { branchId: null }],
      startDate: { lte: date },
      endDate: { gte: date },
    },
  });

  const closures = closureRows.map((c) => ({
    startMin: c.startMin ?? 0,
    endMin: c.endMin ?? 24 * 60,
    reason: c.reason,
  }));
  // A whole-day closure closes the day outright, so the engine says "closed" rather
  // than reporting every slot as clashing with a closure.
  const wholeDay = closures.some((c) => c.startMin === 0 && c.endMin >= 24 * 60);
  const open = day.closed || wholeDay || day.closeMin <= day.openMin ? [] : [{ startMin: day.openMin, endMin: day.closeMin }];
  return { open, closures: wholeDay ? closures.filter((c) => c.startMin === 0 && c.endMin >= 24 * 60) : closures };
}
