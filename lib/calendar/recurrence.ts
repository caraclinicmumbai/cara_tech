// When a task falls due (lib/calendar). Pure: IST date keys in, IST date keys out, so the
// calendar, the overdue count and the tests all agree on what "every month on the 31st"
// means. A repeating task falls due:
//   daily   — every day from its first date;
//   weekly  — on the same weekday;
//   monthly — on the same date, or the month's last day when the month is shorter
//             (the 31st → 30 Apr, 28/29 Feb).
// None before its first date (`dueAt`) or after `repeatUntil`.

export const TASK_REPEATS = ["none", "daily", "weekly", "monthly"] as const;
export type TaskRepeat = (typeof TASK_REPEATS)[number];
export const TASK_REPEAT_LABELS: Record<TaskRepeat, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

export function isTaskRepeat(v: unknown): v is TaskRepeat {
  return typeof v === "string" && (TASK_REPEATS as readonly string[]).includes(v);
}

/// IST date key + n days.
export function addDayKeys(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function parts(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d];
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/// Does a task first due on `firstKey` and repeating `repeat` fall due on `key`?
export function fallsOn(firstKey: string, repeat: TaskRepeat, untilKey: string | null, key: string): boolean {
  if (key < firstKey || (untilKey !== null && key > untilKey)) return false;
  if (repeat === "none") return key === firstKey;
  if (repeat === "daily") return true;
  const [fy, fm, fd] = parts(firstKey);
  const [y, m, d] = parts(key);
  if (repeat === "weekly") {
    const diff = (Date.UTC(y, m - 1, d) - Date.UTC(fy, fm - 1, fd)) / 86_400_000;
    return diff % 7 === 0;
  }
  return d === Math.min(fd, daysInMonth(y, m));
}

/// The dates (IST keys) in [fromKey, toKey] on which the task falls due.
export function occurrencesBetween(
  firstKey: string,
  repeat: TaskRepeat,
  untilKey: string | null,
  fromKey: string,
  toKey: string,
): string[] {
  const out: string[] = [];
  for (let k = fromKey > firstKey ? fromKey : firstKey; k <= toKey; k = addDayKeys(k, 1)) {
    if (untilKey !== null && k > untilKey) break;
    if (fallsOn(firstKey, repeat, untilKey, k)) out.push(k);
  }
  return out;
}
