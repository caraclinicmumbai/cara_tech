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
//   block — the booking is refused. A block marked `overridable` (a clash on a
//           consultation room) can be overridden by a branch manager with a reason.
//   warn  — the booking may go ahead. A warn with `needsAck` (an overbooked doctor or
//           machine) goes ahead only when the person booking has acknowledged it.
//
// WHAT BLOCKS (spec §2.1, decided 2026-10-08): only ROOMS and the OT TEAM (support
// staff) are hard-blocked. Doctors and equipment are tracked and warned about, never
// blocked — unless the clinic flips the matching switch. And the doctor is always
// NAMED (§2.1.d — patients book a specific surgeon): the engine never auto-picks one.
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
  /// Rooms only: a branch manager may override a clash on this room (consultation
  /// rooms — §2.1.c). Never true for an OT.
  allowOverride: boolean;
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
  blockEquipment: boolean;
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
  | "equipment_overbooked"
  | "room_overridden"
  | "doctor_not_chosen"
  | "requirement_unfilled"
  | "unknown_resource";

export type Issue = {
  code: IssueCode;
  severity: "block" | "warn";
  message: string;
  resourceId?: string;
  /// The booking may proceed only once someone acknowledges this warning.
  needsAck?: boolean;
  /// A block that a branch manager may override with a reason (consultation room clash).
  overridable?: boolean;
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
  /// A branch manager is overriding clashes on overridable (consultation) rooms. The
  /// caller checks the capability and records the reason; the engine only downgrades
  /// those specific blocks to warnings.
  override?: boolean;
  now?: Date;
};

export type SlotResult = {
  ok: boolean; // no block-level issue
  needsAck: boolean; // ok, but a warning must be acknowledged first
  /// Not ok, but every block is overridable — a branch manager could book it.
  overridable: boolean;
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
        severity:
          res.kind === "room" ||
          (res.kind === "equipment" && toggles.blockEquipment) ||
          ((res.kind === "doctor" || res.kind === "staff") && toggles.enforceStaffRosters)
            ? "block"
            : "warn",
        needsAck: res.kind === "equipment" && !toggles.blockEquipment ? true : undefined,
        message: `${res.name} is unavailable${off.reason ? ` (${off.reason})` : ""}`,
        resourceId: res.id,
      });
      break;
    }
  }

  // Already booked. THE rule: rooms and the OT team never double. Doctors and
  // equipment may, with an acknowledged warning, unless the clinic switched that off.
  // A consultation room may be overridden by a branch manager.
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
    } else if (res.kind === "equipment" && !toggles.blockEquipment) {
      issues.push({
        code: "equipment_overbooked",
        severity: "warn",
        needsAck: true,
        message: `${res.name} is already in use ${span}`,
        resourceId: res.id,
      });
    } else if (res.kind === "room" && res.allowOverride && req.override) {
      issues.push({
        code: "room_overridden",
        severity: "warn",
        message: `${res.name} is already booked ${span} — overridden by a branch manager`,
        resourceId: res.id,
      });
    } else if (res.kind === "room" && res.allowOverride) {
      issues.push({
        code: "double_booked",
        severity: "block",
        overridable: true,
        message: `${res.name} is already booked ${span}`,
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

    // The doctor is always named by the person booking (§2.1.d) — never auto-picked.
    if (r.kind === "doctor" && !r.resourceId) {
      issues.push({ code: "doctor_not_chosen", severity: "block", message: "Choose the doctor" });
      continue;
    }

    // 2. Auto-fill from the free pool — first choice is a resource with NOTHING in the
    //    way, so a free machine always beats a busy one.
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
    // 3. Nothing completely free: take one whose problems are only WARNINGS (a machine
    //    already in use, when equipment isn't blocked) and surface those warnings, so
    //    the booking needs an acknowledgement rather than being refused. A room or the
    //    OT team can't get here — their clashes are always blocks.
    for (const res of pool) {
      if (filled >= r.quantity) break;
      if (used.has(res.id)) continue;
      const found = resourceIssues(ctx, res, req);
      if (found.some((i) => i.severity === "block")) continue;
      used.add(res.id);
      assigned.push(res.id);
      issues.push(...found);
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

  const blocks = issues.filter((i) => i.severity === "block");
  const ok = blocks.length === 0;
  return {
    ok,
    needsAck: ok && issues.some((i) => i.needsAck),
    overridable: !ok && blocks.every((i) => i.overridable),
    resourceIds: assigned,
    issues,
  };
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

/// Why a day offers no slot (§2.1 "shows the front desk why Saturday failed"). Walks
/// the same start times findSlots does, collects the blocking reasons, and returns
/// the distinct ones, most common first — "Needs 3 × technician — only 2 free",
/// "OT-1 is already booked 08:00–16:45". Branch-level reasons (closed, holiday) come
/// back alone, because nothing else matters on a closed day.
export function explainDay(
  ctx: DayContext,
  opts: Parameters<typeof findSlots>[1],
  limit = 4,
): string[] {
  const step = opts.stepMin ?? 15;
  const windows = ctx.toggles.enforceBranchHours ? ctx.open : [{ startMin: 0, endMin: 24 * 60 }];
  if (windows.length === 0) {
    const closure = ctx.closures.find((c) => c.startMin === 0 && c.endMin >= 24 * 60);
    return [closure ? `Branch closed: ${closure.reason}` : "The branch is closed on this day"];
  }
  const counts = new Map<string, number>();
  let tried = 0;
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
      tried++;
      for (const i of r.issues) {
        if (i.severity !== "block") continue;
        counts.set(i.message, (counts.get(i.message) ?? 0) + 1);
      }
    }
  }
  if (tried === 0) {
    const hours = windows.map((w) => `${fmt(w.startMin)}–${fmt(w.endMin)}`).join(", ");
    return [`Too long to fit in the branch's hours (${hours})`];
  }
  // "That time has already passed" is noise when the day still has other reasons.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([msg]) => msg);
  const useful = ranked.filter((m) => m !== "That time has already passed");
  return (useful.length ? useful : ranked).slice(0, limit);
}
