// The scheduling conflict engine (§3.2). PURE — no database. It is handed everything
// it needs about one branch on one day (a DayContext) and answers two questions:
//
//   evaluateSlot — can this appointment go here, with which resources, and what's in
//                  the way?
//   findSlots    — which start times on this day work at all?
//
// lib/scheduling/booking.ts loads the DayContext, takes the locks, and calls this. The
// split exists so the rules can be exercised directly (scripts/checkScheduling.ts)
// without a database, and so booking, rescheduling, the slot picker and the online
// booking page can never disagree about what "free" means: there is one definition.
//
// Severity:
//   block — the booking is refused.
//   warn  — the booking may go ahead. A warn with `needsAck` (an overbooked doctor)
//           goes ahead only when the person booking has acknowledged it.
import type { ResourceKind } from "@/lib/scheduling/status";
import { istDateKey, istMinutes, overlaps, MINUTE_MS, minutesToHhmm } from "@/lib/scheduling/time";

export type Window = { startMin: number; endMin: number };

export type EngineResource = {
  id: string;
  kind: ResourceKind;
  subtype: string | null;
  name: string;
  branchId: string | null;
  active: boolean;
  sortOrder: number;
  /// Roster windows AT THIS BRANCH on this weekday. `hasRoster` says whether the person
  /// has a roster anywhere — someone with no roster at all is available whenever the
  /// branch is open; someone with a roster only inside it.
  rosterHere: Window[];
  hasRoster: boolean;
  timeOff: { startAt: Date; endAt: Date; reason: string | null }[];
};

export type Busy = { resourceId: string; appointmentId: string; startAt: Date; endAt: Date };

export type EngineToggles = {
  allowDoctorDoubleBooking: boolean;
  enforceBranchHours: boolean;
  enforceStaffRosters: boolean;
  requireSupportStaff: boolean;
};

export type DayContext = {
  branchId: string;
  dateKey: string; // IST "YYYY-MM-DD"
  /// Open windows for the day; empty = closed all day.
  open: Window[];
  closures: { startMin: number; endMin: number; reason: string }[];
  resources: Map<string, EngineResource>;
  busy: Busy[];
  toggles: EngineToggles;
};

export type Requirement = {
  kind: ResourceKind;
  subtype: string | null;
  resourceId: string | null;
  quantity: number;
};

export type IssueCode =
  | "crosses_midnight"
  | "in_past"
  | "branch_closed"
  | "outside_hours"
  | "closure"
  | "resource_inactive"
  | "wrong_branch"
  | "off_roster"
  | "time_off"
  | "double_booked"
  | "doctor_overbooked"
  | "requirement_unfilled"
  | "unknown_resource";

export type Issue = {
  code: IssueCode;
  severity: "block" | "warn";
  message: string;
  resourceId?: string;
  /// The booking may proceed only once someone acknowledges this warning.
  needsAck?: boolean;
};

export type SlotRequest = {
  startAt: Date;
  /// Patient's end — what the patient is told.
  endAt: Date;
  /// Resources are held until here (endAt + turnover buffer).
  holdUntil: Date;
  requirements: Requirement[];
  /// Resources the person booking picked (a specific doctor, room…). Filled first.
  chosenIds: string[];
  /// Appointments to treat as not there — the one being rescheduled.
  ignoreAppointmentIds?: string[];
  /// Allow a start time in the past (back-dating a walk-in that's already here).
  allowPast?: boolean;
  now?: Date;
};

export type SlotResult = {
  ok: boolean; // no block-level issue
  needsAck: boolean; // ok, but a warning must be acknowledged first
  resourceIds: string[]; // the full assignment (chosen + auto-filled)
  issues: Issue[];
};

const KIND_NOUN: Record<ResourceKind, string> = {
  doctor: "doctor",
  room: "room",
  equipment: "equipment",
  staff: "staff member",
};

function describeRequirement(r: Requirement, ctx: DayContext): string {
  if (r.resourceId) return ctx.resources.get(r.resourceId)?.name ?? "a specific resource";
  const noun = r.subtype ? `${r.subtype} ${r.kind === "staff" ? "" : KIND_NOUN[r.kind]}`.trim() : KIND_NOUN[r.kind];
  return `${r.quantity} × ${noun}`;
}

function fmt(min: number): string {
  return minutesToHhmm(min);
}

function matches(res: EngineResource, req: Requirement): boolean {
  if (req.resourceId) return res.id === req.resourceId;
  if (res.kind !== req.kind) return false;
  if (req.subtype && (res.subtype ?? "").toLowerCase() !== req.subtype.toLowerCase()) return false;
  return true;
}

/// Everything that stands between one resource and [start, holdUntil). Also used on
/// its own by the UI to grey out a doctor in the picker.
export function resourceIssues(ctx: DayContext, res: EngineResource, req: SlotRequest): Issue[] {
  const issues: Issue[] = [];
  const { toggles } = ctx;
  const startMin = istMinutes(req.startAt);
  const endMin = istMinutes(req.endAt) || 24 * 60;

  if (!res.active) {
    issues.push({ code: "resource_inactive", severity: "block", message: `${res.name} is inactive`, resourceId: res.id });
  }

  // Rooms and equipment are physically in one branch.
  if ((res.kind === "room" || res.kind === "equipment") && res.branchId && res.branchId !== ctx.branchId) {
    issues.push({ code: "wrong_branch", severity: "block", message: `${res.name} belongs to another branch`, resourceId: res.id });
  }

  // Doctors and staff: inside their roster at THIS branch, if they have one.
  if ((res.kind === "doctor" || res.kind === "staff") && res.hasRoster) {
    const covered = res.rosterHere.some((w) => w.startMin <= startMin && endMin <= w.endMin);
    if (!covered) {
      const when = res.rosterHere.length
        ? `rostered here ${res.rosterHere.map((w) => `${fmt(w.startMin)}–${fmt(w.endMin)}`).join(", ")}`
        : "not rostered at this branch on this day";
      issues.push({
        code: "off_roster",
        severity: toggles.enforceStaffRosters ? "block" : "warn",
        message: `${res.name} is ${when}`,
        resourceId: res.id,
      });
    }
  }

  // Leave / maintenance. Always at least a warning: a booking into someone's leave is
  // never something to do silently.
  for (const off of res.timeOff) {
    if (overlaps(req.startAt, req.holdUntil, off.startAt, off.endAt)) {
      issues.push({
        code: "time_off",
        severity: toggles.enforceStaffRosters || res.kind === "room" || res.kind === "equipment" ? "block" : "warn",
        message: `${res.name} is unavailable${off.reason ? ` (${off.reason})` : ""}`,
        resourceId: res.id,
      });
      break;
    }
  }

  // Already booked. THE rule: rooms, equipment and staff never double; doctors may,
  // with an acknowledged warning, when the clinic allows it.
  const ignore = new Set(req.ignoreAppointmentIds ?? []);
  const clash = ctx.busy.find(
    (b) => b.resourceId === res.id && !ignore.has(b.appointmentId) && overlaps(req.startAt, req.holdUntil, b.startAt, b.endAt),
  );
  if (clash) {
    const span = `${fmt(istMinutes(clash.startAt))}–${fmt(istMinutes(clash.endAt) || 1440)}`;
    if (res.kind === "doctor" && toggles.allowDoctorDoubleBooking) {
      issues.push({
        code: "doctor_overbooked",
        severity: "warn",
        needsAck: true,
        message: `${res.name} already has a patient ${span} — this double-books them`,
        resourceId: res.id,
      });
    } else {
      issues.push({ code: "double_booked", severity: "block", message: `${res.name} is already booked ${span}`, resourceId: res.id });
    }
  }

  return issues;
}

function branchIssues(ctx: DayContext, req: SlotRequest): Issue[] {
  const issues: Issue[] = [];
  const sev = ctx.toggles.enforceBranchHours ? "block" : "warn";
  const startMin = istMinutes(req.startAt);
  const endMin = istMinutes(req.endAt) || 24 * 60;

  if (ctx.open.length === 0) {
    issues.push({ code: "branch_closed", severity: sev, message: "The branch is closed on this day" });
  } else if (!ctx.open.some((w) => w.startMin <= startMin && endMin <= w.endMin)) {
    const hours = ctx.open.map((w) => `${fmt(w.startMin)}–${fmt(w.endMin)}`).join(", ");
    issues.push({ code: "outside_hours", severity: sev, message: `Outside branch hours (${hours})` });
  }
  for (const c of ctx.closures) {
    if (startMin < c.endMin && c.startMin < endMin) {
      issues.push({ code: "closure", severity: sev, message: `Branch closed: ${c.reason}` });
      break;
    }
  }
  return issues;
}

/// Can this appointment go here? Fills every requirement — chosen resources first,
/// then the first free matching ones — and reports everything in the way.
export function evaluateSlot(ctx: DayContext, req: SlotRequest): SlotResult {
  const issues: Issue[] = [];
  const now = req.now ?? new Date();

  // One appointment, one IST day. A multi-day surgery is a series (Phase D), not one row.
  if (istDateKey(new Date(req.holdUntil.getTime() - MINUTE_MS)) !== istDateKey(req.startAt)) {
    issues.push({ code: "crosses_midnight", severity: "block", message: "An appointment can't run past midnight" });
  }
  if (!req.allowPast && req.startAt < now) {
    issues.push({ code: "in_past", severity: "block", message: "That time has already passed" });
  }
  issues.push(...branchIssues(ctx, req));

  const assigned: string[] = [];
  const used = new Set<string>();
  const chosen = req.chosenIds.filter((id, i, a) => a.indexOf(id) === i);

  for (const id of chosen) {
    if (!ctx.resources.has(id)) {
      issues.push({ code: "unknown_resource", severity: "block", message: "A selected resource no longer exists", resourceId: id });
    }
  }

  const requirements = req.requirements.filter((r) => r.kind !== "staff" || ctx.toggles.requireSupportStaff);

  for (const r of requirements) {
    let filled = 0;
    // 1. The person booking chose these — honour them and report what's wrong with them.
    for (const id of chosen) {
      if (filled >= r.quantity) break;
      const res = ctx.resources.get(id);
      if (!res || used.has(id) || !matches(res, r)) continue;
      used.add(id);
      assigned.push(id);
      issues.push(...resourceIssues(ctx, res, req));
      filled++;
    }
    if (filled >= r.quantity) continue;

    // 2. Auto-fill from the free pool. Only a resource with NOTHING in the way is
    //    auto-picked — the system never silently picks an overbooked doctor.
    const pool = [...ctx.resources.values()]
      .filter((res) => !used.has(res.id) && matches(res, r))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const res of pool) {
      if (filled >= r.quantity) break;
      if (resourceIssues(ctx, res, req).length > 0) continue;
      used.add(res.id);
      assigned.push(res.id);
      filled++;
    }
    if (filled < r.quantity) {
      issues.push({
        code: "requirement_unfilled",
        severity: "block",
        message: `Needs ${describeRequirement(r, ctx)} — only ${filled} free`,
      });
    }
  }

  // 3. Anything chosen that no requirement asked for (an extra nurse) is still booked
  //    and still checked — extra people can't be in two places either.
  for (const id of chosen) {
    if (used.has(id)) continue;
    const res = ctx.resources.get(id);
    if (!res) continue;
    used.add(id);
    assigned.push(id);
    issues.push(...resourceIssues(ctx, res, req));
  }

  const ok = !issues.some((i) => i.severity === "block");
  return { ok, needsAck: ok && issues.some((i) => i.needsAck), resourceIds: assigned, issues };
}

export type SlotOption = {
  startAt: Date;
  endAt: Date;
  needsAck: boolean;
  resourceIds: string[];
  warnings: Issue[];
};

/// Every workable start time on the context's day, stepping through the open windows.
/// A slot that only works by overbooking a doctor is returned flagged `needsAck`
/// (unless `excludeNeedsAck`), so a picker can show it differently or hide it.
export function findSlots(
  ctx: DayContext,
  opts: {
    durationMin: number;
    bufferAfterMin: number;
    requirements: Requirement[];
    chosenIds: string[];
    stepMin?: number;
    ignoreAppointmentIds?: string[];
    excludeNeedsAck?: boolean;
    now?: Date;
    istInstant: (dateKey: string, minutes: number) => Date;
  },
): SlotOption[] {
  const step = opts.stepMin ?? 15;
  const out: SlotOption[] = [];
  // When hours aren't enforced the whole day is fair game; otherwise, only open time.
  const windows = ctx.toggles.enforceBranchHours ? ctx.open : [{ startMin: 0, endMin: 24 * 60 }];
  for (const w of windows) {
    for (let m = Math.ceil(w.startMin / step) * step; m + opts.durationMin <= w.endMin; m += step) {
      const startAt = opts.istInstant(ctx.dateKey, m);
      const endAt = new Date(startAt.getTime() + opts.durationMin * MINUTE_MS);
      const holdUntil = new Date(endAt.getTime() + opts.bufferAfterMin * MINUTE_MS);
      const r = evaluateSlot(ctx, {
        startAt,
        endAt,
        holdUntil,
        requirements: opts.requirements,
        chosenIds: opts.chosenIds,
        ignoreAppointmentIds: opts.ignoreAppointmentIds,
        now: opts.now,
      });
      if (!r.ok) continue;
      if (r.needsAck && opts.excludeNeedsAck) continue;
      out.push({ startAt, endAt, needsAck: r.needsAck, resourceIds: r.resourceIds, warnings: r.issues });
    }
  }
  return out;
}
