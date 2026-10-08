"use server";

// Server Actions for the Scheduling setup screen (§3.2) — the module's switches,
// branch hours and holidays, resources and rosters, appointment types and patient
// flags. Gated to `appointments.configure`; every change is written to the audit log,
// because "who closed Andheri on the 14th" and "who switched off double-booking
// protection" both have to be answerable.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getBoolSetting, setBoolSetting, getNumberSetting, setNumberSetting } from "@/lib/settings";
import { isSchedulingToggle, SCHEDULING_TOGGLES, SCHEDULING_NUMBERS } from "@/lib/scheduling/toggles";
import { loadTravel } from "@/lib/scheduling/booking";
import { isResourceKind, RESOURCE_KIND_LABELS } from "@/lib/scheduling/status";
import { dateColumn, hhmmToMinutes, istInstant as istInstantOf } from "@/lib/scheduling/time";
import { parseIstDateTimeLocal } from "@/lib/datetime";
import { FLAG_ICONS, FLAG_TONES } from "@/lib/scheduling/flags";
import { REMINDER_PRESETS } from "@/lib/scheduling/messageText";
import { detectClosure, detectConflicts, detectForResource, recheckOpenCases } from "@/lib/scheduling/conflicts";

type Result = { ok: boolean; error?: string; info?: string; id?: string };

const PATH = "/appointments/setup";

function clean(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length ? s : null;
}

function fail(where: string, err: unknown, message: string): Result {
  logger.error(`${where} failed: ${String(err)}`);
  return { ok: false, error: message };
}

async function audit(
  actor: { id?: string; email?: string | null },
  action: string,
  entityId: string | null,
  newValue: string,
  extra: { oldValue?: string | null; reason?: string | null; meta?: Record<string, unknown> } = {},
) {
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    entityType: "scheduling",
    entityId,
    newValue,
    ...extra,
  });
}

// ── Switches ─────────────────────────────────────────────────────────────────

export async function setSchedulingToggle(key: string, value: boolean): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  if (!isSchedulingToggle(key)) return { ok: false, error: "Unknown switch" };
  const label = SCHEDULING_TOGGLES.find((t) => t.key === key)?.label ?? key;
  try {
    const old = await getBoolSetting(key);
    await setBoolSetting(key, value, actor.id ?? null);
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "toggle.change",
      entityType: "setting",
      entityId: key,
      field: "value",
      oldValue: String(old),
      newValue: String(value),
      reason: `${label} switched ${value ? "on" : "off"}`,
    });
    revalidatePath(PATH);
    revalidatePath("/", "layout");
    return { ok: true, info: `${label}: ${value ? "on" : "off"}` };
  } catch (err) {
    return fail("setSchedulingToggle", err, "Could not save the switch");
  }
}

export async function setSchedulingNumber(key: string, value: number): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const def = SCHEDULING_NUMBERS.find((n) => n.key === key);
  if (!def) return { ok: false, error: "Unknown setting" };
  const v = Math.round(Number(value));
  if (!Number.isFinite(v) || v < def.min || v > def.max) return { ok: false, error: `Must be ${def.min}–${def.max} ${def.unit}` };
  try {
    const old = await getNumberSetting(key);
    await setNumberSetting(key, v, actor.id ?? null);
    await writeAudit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "settings.update",
      entityType: "setting",
      entityId: key,
      field: "value",
      oldValue: String(old),
      newValue: String(v),
      reason: def.label,
    });
    revalidatePath(PATH);
    return { ok: true, info: `${def.label}: ${v} ${def.unit}` };
  } catch (err) {
    return fail("setSchedulingNumber", err, "Could not save the setting");
  }
}

/// Set (or clear, with null) the travel time between two branches (§2.2.a). Stored
/// once per unordered pair.
export async function saveTravelTime(branchX: string, branchY: string, minutes: number | null): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  if (!branchX || !branchY || branchX === branchY) return { ok: false, error: "Pick two different branches" };
  const [a, b] = branchX < branchY ? [branchX, branchY] : [branchY, branchX];
  try {
    if (minutes === null) {
      await prisma.branchTravelTime.deleteMany({ where: { branchAId: a, branchBId: b } });
    } else {
      const m = Math.round(Number(minutes));
      if (!Number.isFinite(m) || m < 0 || m > 600) return { ok: false, error: "Travel time must be 0–600 minutes" };
      await prisma.branchTravelTime.upsert({
        where: { branchAId_branchBId: { branchAId: a, branchBId: b } },
        create: { branchAId: a, branchBId: b, minutes: m },
        update: { minutes: m },
      });
    }
    await audit(actor, "scheduling.travel.update", `${a}|${b}`, minutes === null ? "default" : `${minutes} min`);
    revalidatePath(PATH);
    return { ok: true, info: minutes === null ? "Reset to the default" : "Saved" };
  } catch (err) {
    return fail("saveTravelTime", err, "Could not save the travel time");
  }
}

/// Same-day rows at two different branches must leave room to travel (§2.2). Returns
/// an error message, or null when the rows are fine.
async function travelProblem(rows: { branchId: string; startMin: number; endMin: number }[]): Promise<string | null> {
  if (rows.length < 2) return null;
  const travel = await loadTravel(prisma);
  const sorted = [...rows].sort((x, y) => x.startMin - y.startMin);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.branchId === cur.branchId) continue;
    const need = travel.minutes(prev.branchId, cur.branchId);
    if (cur.startMin - prev.endMin < need) {
      const from = travel.names.get(prev.branchId) ?? "one branch";
      const to = travel.names.get(cur.branchId) ?? "the next";
      return `Leave at least ${need} min to travel from ${from} to ${to}`;
    }
  }
  return null;
}

// ── Branch hours & holidays ──────────────────────────────────────────────────

export type DayHoursInput = { weekday: number; open: string; close: string; closed: boolean };

export async function saveBranchHours(branchId: string, week: DayHoursInput[]): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  if (week.length !== 7) return { ok: false, error: "All seven days are needed" };
  const rows = [];
  for (const d of week) {
    if (!Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6) return { ok: false, error: "Bad weekday" };
    const openMin = hhmmToMinutes(d.open);
    const closeMin = hhmmToMinutes(d.close);
    if (!d.closed && (openMin === null || closeMin === null || closeMin <= openMin)) {
      return { ok: false, error: "Each open day needs an opening time before its closing time (HH:MM)" };
    }
    rows.push({ weekday: d.weekday, openMin: openMin ?? 0, closeMin: closeMin ?? 0, closed: d.closed });
  }
  try {
    await prisma.$transaction(
      rows.map((r) =>
        prisma.branchHours.upsert({
          where: { branchId_weekday: { branchId, weekday: r.weekday } },
          create: { branchId, ...r },
          update: r,
        }),
      ),
    );
    await audit(actor, "scheduling.hours.update", branchId, JSON.stringify(week));
    revalidatePath(PATH);
    return { ok: true, info: "Branch hours saved" };
  } catch (err) {
    return fail("saveBranchHours", err, "Could not save the hours");
  }
}

export type ClosureInput = {
  branchId: string | null; // null = every branch
  startDate: string; // YYYY-MM-DD
  endDate: string;
  startTime?: string; // HH:MM — both blank = whole day
  endTime?: string;
  reason: string;
};

export async function addClosure(input: ClosureInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const reason = clean(input.reason);
  if (!reason) return { ok: false, error: "Give the closure a reason (e.g. Diwali)" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) return { ok: false, error: "Pick a start date" };
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? input.endDate : input.startDate;
  if (endDate < input.startDate) return { ok: false, error: "The end date is before the start date" };
  const st = clean(input.startTime);
  const et = clean(input.endTime);
  let startMin: number | null = null;
  let endMin: number | null = null;
  if (st || et) {
    startMin = st ? hhmmToMinutes(st) : null;
    endMin = et ? hhmmToMinutes(et) : null;
    if (startMin === null || endMin === null || endMin <= startMin) {
      return { ok: false, error: "A part-day closure needs a start and end time (HH:MM), start first" };
    }
  }
  try {
    const row = await prisma.branchClosure.create({
      data: {
        branchId: input.branchId || null,
        startDate: dateColumn(input.startDate),
        endDate: dateColumn(endDate),
        startMin,
        endMin,
        reason,
        createdById: actor.id ?? null,
      },
      select: { id: true },
    });
    await audit(actor, "scheduling.closure.create", row.id, `${reason}: ${input.startDate}–${endDate}`, {
      meta: { branchId: input.branchId, startMin, endMin },
    });
    const opened = await detectClosure({
      branchId: input.branchId || null,
      startDateKey: input.startDate,
      endDateKey: endDate,
      startMin,
      endMin,
      reason,
      actor,
    });
    revalidatePath(PATH);
    return { ok: true, id: row.id, info: opened ? `Saved. ${opened} booked appointment(s) fall on it — see Needs rebooking.` : "Saved" };
  } catch (err) {
    return fail("addClosure", err, "Could not add the closure");
  }
}

export async function deleteClosure(id: string): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  try {
    const row = await prisma.branchClosure.delete({ where: { id } });
    await audit(actor, "scheduling.closure.delete", id, row.reason, {
      oldValue: `${row.startDate.toISOString().slice(0, 10)}–${row.endDate.toISOString().slice(0, 10)}`,
    });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return fail("deleteClosure", err, "Could not remove the closure");
  }
}

// ── Resources, rosters, time off ─────────────────────────────────────────────

export type ResourceInput = {
  kind: string;
  subtype?: string | null;
  name: string;
  branchId?: string | null;
  userId?: string | null;
  notes?: string | null;
  /// Rooms only: a branch manager may override a clash here (§2.1.c).
  allowOverride?: boolean;
  /// Visiting doctors (§2.9.e): contract dates, "YYYY-MM-DD" or blank.
  availableFrom?: string | null;
  availableUntil?: string | null;
};

function normaliseResource(
  input: ResourceInput,
): {
  ok: true;
  data: Omit<ResourceInput, "kind" | "allowOverride" | "availableFrom" | "availableUntil"> & {
    kind: string;
    allowOverride: boolean;
    availableFrom: Date | null;
    availableUntil: Date | null;
  };
} | Result {
  if (!isResourceKind(input.kind)) return { ok: false, error: "Pick what kind of resource this is" };
  const name = clean(input.name);
  if (!name) return { ok: false, error: "Give it a name" };
  const branchId = clean(input.branchId);
  if ((input.kind === "room" || input.kind === "equipment") && !branchId) {
    return { ok: false, error: `A ${RESOURCE_KIND_LABELS[input.kind].toLowerCase()} must belong to a branch` };
  }
  const subtype = clean(input.subtype)?.toLowerCase() ?? null;
  const from = clean(input.availableFrom);
  const until = clean(input.availableUntil);
  const isDate = (v: string | null) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(from) || !isDate(until)) return { ok: false, error: "Contract dates must be dates" };
  if (from && until && until < from) return { ok: false, error: "The contract ends before it starts" };
  // §2.1.c: overrides are for consultation rooms. An OT can never be overridden, so
  // the flag is refused there rather than trusted.
  if (input.allowOverride && input.kind === "room" && subtype === "ot") {
    return { ok: false, error: "An OT can't allow overrides — only consultation rooms can" };
  }
  return {
    ok: true,
    data: {
      kind: input.kind,
      subtype,
      allowOverride: input.kind === "room" && !!input.allowOverride,
      availableFrom: input.kind === "doctor" || input.kind === "staff" ? (from ? dateColumn(from) : null) : null,
      availableUntil: input.kind === "doctor" || input.kind === "staff" ? (until ? dateColumn(until) : null) : null,
      name,
      branchId,
      userId: input.kind === "doctor" || input.kind === "staff" ? clean(input.userId) : null,
      notes: clean(input.notes),
    },
  };
}

export async function createResource(input: ResourceInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const n = normaliseResource(input);
  if (!("data" in n)) return n;
  try {
    const row = await prisma.resource.create({ data: n.data, select: { id: true } });
    await audit(actor, "scheduling.resource.create", row.id, `${n.data.kind}: ${n.data.name}`);
    revalidatePath(PATH);
    return { ok: true, id: row.id };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "That staff login is already linked to another resource" };
    return fail("createResource", err, "Could not add the resource");
  }
}

export async function updateResource(id: string, input: ResourceInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const n = normaliseResource(input);
  if (!("data" in n)) return n;
  try {
    await prisma.resource.update({ where: { id }, data: n.data });
    await audit(actor, "scheduling.resource.update", id, `${n.data.kind}: ${n.data.name}`);
    // A changed branch or contract window can strand booked appointments (§2.9).
    const d = await detectForResource(id, "contract", actor);
    revalidatePath(PATH);
    return { ok: true, info: d.opened ? `Saved. ${d.opened} appointment(s) need rebooking.` : "Saved" };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "That staff login is already linked to another resource" };
    return fail("updateResource", err, "Could not save the resource");
  }
}

/// Retire / restore a resource. Retiring never deletes — past appointments still name it.
export async function setResourceActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  try {
    const r = await prisma.resource.update({ where: { id }, data: { active }, select: { name: true } });
    await audit(actor, active ? "scheduling.resource.activate" : "scheduling.resource.deactivate", id, r.name);
    const d = await detectForResource(id, "downtime", actor);
    revalidatePath(PATH);
    return { ok: true, info: d.opened ? `${d.opened} appointment(s) need rebooking.` : undefined };
  } catch (err) {
    return fail("setResourceActive", err, "Could not update the resource");
  }
}

export type RosterRowInput = { branchId: string; weekday: number; start: string; end: string };

/// Replace a doctor's / staff member's whole weekly roster. An empty list means "no
/// roster" — available whenever their branch is open.
export async function saveRoster(resourceId: string, rows: RosterRowInput[]): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const parsed = [];
  for (const r of rows) {
    const startMin = hhmmToMinutes(r.start);
    const endMin = hhmmToMinutes(r.end);
    if (!r.branchId) return { ok: false, error: "Every roster row needs a branch" };
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return { ok: false, error: "Bad weekday" };
    if (startMin === null || endMin === null || endMin <= startMin) {
      return { ok: false, error: "Each roster row needs a start before its end (HH:MM)" };
    }
    parsed.push({ resourceId, branchId: r.branchId, weekday: r.weekday, startMin, endMin });
  }
  // The same person can't be rostered in two places at once.
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      if (a.weekday === b.weekday && a.startMin < b.endMin && b.startMin < a.endMin) {
        return { ok: false, error: "Two roster rows overlap on the same day" };
      }
    }
  }
  for (let d = 0; d < 7; d++) {
    const problem = await travelProblem(parsed.filter((p) => p.weekday === d));
    if (problem) return { ok: false, error: problem };
  }
  try {
    const r = await prisma.resource.findUnique({ where: { id: resourceId }, select: { kind: true, name: true } });
    if (!r || (r.kind !== "doctor" && r.kind !== "staff")) return { ok: false, error: "Only doctors and staff have rosters" };
    await prisma.$transaction([
      prisma.resourceSchedule.deleteMany({ where: { resourceId } }),
      prisma.resourceSchedule.createMany({ data: parsed }),
    ]);
    await audit(actor, "scheduling.roster.update", resourceId, `${r.name}: ${parsed.length} row(s)`, { meta: { rows } });
    const d = await detectForResource(resourceId, "roster", actor);
    revalidatePath(PATH);
    const base = parsed.length ? "Roster saved" : "Roster cleared — available whenever the branch is open";
    return { ok: true, info: d.opened ? `${base}. ${d.opened} appointment(s) no longer fit and need rebooking.` : base };
  } catch (err) {
    return fail("saveRoster", err, "Could not save the roster");
  }
}

/// A one-off roster change for one date (§2.2): these rows replace the weekly roster
/// for that day. Add several rows for a split day (Andheri morning, Powai afternoon).
export async function addScheduleException(input: {
  resourceId: string;
  date: string;
  branchId: string;
  start: string;
  end: string;
  note?: string | null;
}): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "Pick a date" };
  if (!input.branchId) return { ok: false, error: "Pick a branch" };
  const startMin = hhmmToMinutes(input.start);
  const endMin = hhmmToMinutes(input.end);
  if (startMin === null || endMin === null || endMin <= startMin) return { ok: false, error: "Start must be before end (HH:MM)" };
  try {
    const r = await prisma.resource.findUnique({ where: { id: input.resourceId }, select: { kind: true, name: true } });
    if (!r || (r.kind !== "doctor" && r.kind !== "staff")) return { ok: false, error: "Only doctors and staff have rosters" };
    const date = dateColumn(input.date);
    const same = await prisma.resourceScheduleException.findMany({
      where: { resourceId: input.resourceId, date },
      select: { branchId: true, startMin: true, endMin: true },
    });
    if (same.some((x) => startMin < x.endMin && x.startMin < endMin)) return { ok: false, error: "Overlaps another change on that date" };
    const problem = await travelProblem([...same, { branchId: input.branchId, startMin, endMin }]);
    if (problem) return { ok: false, error: problem };
    const row = await prisma.resourceScheduleException.create({
      data: { resourceId: input.resourceId, date, branchId: input.branchId, startMin, endMin, note: clean(input.note), createdById: actor.id ?? null },
      select: { id: true },
    });
    await audit(actor, "scheduling.exception.create", row.id, `${r.name}: ${input.date} ${input.start}–${input.end}`, {
      meta: { resourceId: input.resourceId, branchId: input.branchId },
    });
    const d = await detectConflicts({
      resourceId: input.resourceId,
      from: istInstantOf(input.date, 0),
      to: istInstantOf(input.date, 1440),
      cause: "exception",
      actor,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      id: row.id,
      info: d.opened
        ? `Saved. ${d.opened} of ${r.name}'s appointments that day no longer fit and need rebooking.`
        : `Saved. This replaces ${r.name}'s weekly roster for that date.`,
    };
  } catch (err) {
    return fail("addScheduleException", err, "Could not save the change");
  }
}

export async function deleteScheduleException(id: string): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  try {
    const row = await prisma.resourceScheduleException.delete({ where: { id } });
    await audit(actor, "scheduling.exception.delete", id, row.date.toISOString().slice(0, 10), { meta: { resourceId: row.resourceId } });
    // Back on the weekly roster for that date — which may itself not fit what's booked.
    const d = await detectForResource(row.resourceId, "roster", actor);
    revalidatePath(PATH);
    return { ok: true, info: d.opened ? `${d.opened} appointment(s) need rebooking.` : undefined };
  } catch (err) {
    return fail("deleteScheduleException", err, "Could not remove the change");
  }
}

export async function addTimeOff(resourceId: string, start: string, end: string, reason: string): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const startAt = parseIstDateTimeLocal(start);
  let endAt = parseIstDateTimeLocal(end);
  if (!startAt) return { ok: false, error: "Pick when the time off starts" };
  // A bare end DATE means "through the end of that day".
  if (endAt && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())) endAt = new Date(endAt.getTime() + 86_400_000);
  if (!endAt || endAt <= startAt) return { ok: false, error: "The end must be after the start" };
  try {
    const res = await prisma.resource.findUnique({ where: { id: resourceId }, select: { kind: true } });
    const isMachine = res?.kind === "room" || res?.kind === "equipment";
    // Entered from setup by someone who configures scheduling = approved directly.
    const row = await prisma.resourceTimeOff.create({
      data: {
        resourceId,
        startAt,
        endAt,
        reason: clean(reason),
        source: "manual",
        kind: isMachine ? "maintenance" : "leave",
        status: "approved",
        decidedById: actor.id ?? null,
        decidedAt: new Date(),
        createdById: actor.id ?? null,
      },
      select: { id: true },
    });
    await audit(actor, "scheduling.timeoff.create", row.id, `${startAt.toISOString()}–${endAt.toISOString()}`, {
      reason: clean(reason),
      meta: { resourceId },
    });
    // Time off never cancels anything already booked (2.9) — affected appointments go
    // to the "needs rebooking" list for a person to handle.
    const d = await detectConflicts({ resourceId, from: startAt, to: endAt, cause: isMachine ? "downtime" : "leave", timeOffId: row.id, actor });
    revalidatePath(PATH);
    return {
      ok: true,
      id: row.id,
      info: d.opened ? `Saved. ${d.opened} appointment(s) fall inside it — see Needs rebooking.` : "Saved",
    };
  } catch (err) {
    return fail("addTimeOff", err, "Could not add the time off");
  }
}

export async function deleteTimeOff(id: string): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  try {
    const row = await prisma.resourceTimeOff.update({ where: { id }, data: { status: "cancelled", decidedById: actor.id ?? null, decidedAt: new Date() } });
    await audit(actor, "scheduling.timeoff.delete", id, `${row.startAt.toISOString()}–${row.endAt.toISOString()}`, {
      meta: { resourceId: row.resourceId },
    });
    await recheckOpenCases({ timeOffId: id });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return fail("deleteTimeOff", err, "Could not remove the time off");
  }
}

// ── Appointment types ────────────────────────────────────────────────────────

export type RequirementInput = { kind: string; subtype?: string | null; resourceId?: string | null; quantity: number };

export type AppointmentTypeInput = {
  name: string;
  code?: string | null;
  category?: string | null;
  durationMin: number;
  bufferAfterMin: number;
  catalogItemId?: string | null;
  onlineBookable: boolean;
  prepInstructions?: string | null;
  color?: string | null;
  requirements: RequirementInput[];
};

function normaliseType(input: AppointmentTypeInput) {
  const name = clean(input.name);
  if (!name) return { ok: false as const, error: "Give the appointment type a name" };
  const durationMin = Math.round(Number(input.durationMin));
  if (!Number.isFinite(durationMin) || durationMin < 5 || durationMin > 24 * 60) {
    return { ok: false as const, error: "Duration must be between 5 minutes and 24 hours" };
  }
  const bufferAfterMin = Math.max(0, Math.round(Number(input.bufferAfterMin) || 0));
  const requirements = [];
  for (const r of input.requirements) {
    if (!isResourceKind(r.kind)) return { ok: false as const, error: "Each requirement needs a kind" };
    const quantity = Math.round(Number(r.quantity));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 20) return { ok: false as const, error: "Quantity must be 1–20" };
    requirements.push({
      kind: r.kind,
      subtype: clean(r.subtype)?.toLowerCase() ?? null,
      resourceId: clean(r.resourceId),
      quantity: clean(r.resourceId) ? 1 : quantity,
    });
  }
  return {
    ok: true as const,
    data: {
      name,
      code: clean(input.code),
      category: clean(input.category),
      durationMin,
      bufferAfterMin,
      catalogItemId: clean(input.catalogItemId),
      onlineBookable: !!input.onlineBookable,
      prepInstructions: clean(input.prepInstructions),
      color: clean(input.color),
    },
    requirements,
  };
}

export async function createAppointmentType(input: AppointmentTypeInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const n = normaliseType(input);
  if (!n.ok) return n;
  try {
    const row = await prisma.appointmentType.create({
      data: { ...n.data, requirements: { create: n.requirements } },
      select: { id: true },
    });
    await audit(actor, "scheduling.type.create", row.id, n.data.name, { meta: { ...n.data, requirements: n.requirements } });
    revalidatePath(PATH);
    return { ok: true, id: row.id };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "An appointment type with that name exists" };
    return fail("createAppointmentType", err, "Could not add the appointment type");
  }
}

/// Edits apply to FUTURE bookings only. Existing appointments keep the resources they
/// were booked with — changing "FUE needs 2 technicians" to 3 doesn't reach back into
/// next Tuesday's surgery.
export async function updateAppointmentType(id: string, input: AppointmentTypeInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const n = normaliseType(input);
  if (!n.ok) return n;
  try {
    await prisma.$transaction([
      prisma.appointmentType.update({ where: { id }, data: n.data }),
      prisma.appointmentTypeRequirement.deleteMany({ where: { typeId: id } }),
      prisma.appointmentTypeRequirement.createMany({ data: n.requirements.map((r) => ({ ...r, typeId: id })) }),
    ]);
    await audit(actor, "scheduling.type.update", id, n.data.name, { meta: { ...n.data, requirements: n.requirements } });
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "An appointment type with that name exists" };
    return fail("updateAppointmentType", err, "Could not save the appointment type");
  }
}

export async function setAppointmentTypeActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  try {
    const t = await prisma.appointmentType.update({ where: { id }, data: { active }, select: { name: true } });
    await audit(actor, active ? "scheduling.type.activate" : "scheduling.type.deactivate", id, t.name);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return fail("setAppointmentTypeActive", err, "Could not update the appointment type");
  }
}

// ── Patient flags ────────────────────────────────────────────────────────────

export type FlagInput = { label: string; description?: string | null; icon: string; tone: string };

function normaliseFlag(input: FlagInput) {
  const label = clean(input.label);
  if (!label) return { ok: false as const, error: "Give the flag a label" };
  const icon = (FLAG_ICONS as readonly string[]).includes(input.icon) ? input.icon : "dot";
  const tone = (FLAG_TONES as readonly string[]).includes(input.tone) ? input.tone : "ink";
  return { ok: true as const, data: { label, description: clean(input.description), icon, tone } };
}

export async function createFlag(input: FlagInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const n = normaliseFlag(input);
  if (!n.ok) return n;
  const key = n.data.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `flag_${Date.now()}`;
  try {
    const max = await prisma.flagDefinition.aggregate({ _max: { sortOrder: true } });
    const row = await prisma.flagDefinition.create({
      data: { key, ...n.data, sortOrder: (max._max.sortOrder ?? 0) + 1 },
      select: { id: true },
    });
    await audit(actor, "scheduling.flag.create", row.id, n.data.label);
    revalidatePath(PATH);
    return { ok: true, id: row.id };
  } catch (err) {
    if (String(err).includes("Unique constraint")) return { ok: false, error: "A flag with that name exists" };
    return fail("createFlag", err, "Could not add the flag");
  }
}

export async function updateFlag(id: string, input: FlagInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const n = normaliseFlag(input);
  if (!n.ok) return n;
  try {
    await prisma.flagDefinition.update({ where: { id }, data: n.data });
    await audit(actor, "scheduling.flag.update", id, n.data.label);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return fail("updateFlag", err, "Could not save the flag");
  }
}

export async function setFlagActive(id: string, active: boolean): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  try {
    const f = await prisma.flagDefinition.update({ where: { id }, data: { active }, select: { label: true } });
    await audit(actor, active ? "scheduling.flag.activate" : "scheduling.flag.deactivate", id, f.label);
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    return fail("setFlagActive", err, "Could not update the flag");
  }
}

// ── Messages & reminders (§2.4) ──────────────────────────────────────────────

export type MessageTemplateInput = {
  name: string;
  body: string;
  whatsappTemplateName?: string | null;
  whatsappLanguage?: string | null;
  whatsappParams?: string; // comma-separated placeholder names, in {{1}}, {{2}} order
  smsDltTemplateId?: string | null;
  emailSubject?: string | null;
};

const PLACEHOLDER = /^[a-z_]+$/;

export async function saveMessageTemplate(id: string | null, input: MessageTemplateInput): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const name = clean(input.name);
  const body = (input.body ?? "").trim();
  if (!name) return { ok: false, error: "Give the message a name" };
  if (!body) return { ok: false, error: "Write the message" };
  const params = (input.whatsappParams ?? "")
    .split(",")
    .map((p) => p.trim().replace(/^\{|\}$/g, ""))
    .filter(Boolean);
  if (params.some((p) => !PLACEHOLDER.test(p))) return { ok: false, error: "WhatsApp parameters are placeholder names, e.g. patient_name, date, time" };
  const data = {
    name,
    body,
    whatsappTemplateName: clean(input.whatsappTemplateName),
    whatsappLanguage: clean(input.whatsappLanguage) ?? "en",
    whatsappParams: params,
    smsDltTemplateId: clean(input.smsDltTemplateId),
    emailSubject: clean(input.emailSubject),
    updatedById: actor.id ?? null,
  };
  try {
    const row = id
      ? await prisma.appointmentMessageTemplate.update({ where: { id }, data, select: { id: true } })
      : await prisma.appointmentMessageTemplate.create({
          data: { ...data, key: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}_${Date.now().toString(36)}` },
          select: { id: true },
        });
    await audit(actor, id ? "scheduling.message.update" : "scheduling.message.create", row.id, name);
    revalidatePath(PATH);
    return { ok: true, id: row.id, info: "Saved" };
  } catch (err) {
    return fail("saveMessageTemplate", err, "Could not save the message");
  }
}

export type ReminderRuleInput = {
  kind: string; // on_booking | before | morning_of
  hoursBefore?: number | null; // for "before"
  at?: string | null; // HH:MM for "morning_of"
  templateId: string;
  channels: string[];
  smsFallback: boolean;
  quietExempt: boolean;
};

export async function saveReminderSettings(typeId: string, cutoffHours: number, rules: ReminderRuleInput[]): Promise<Result> {
  const actor = await requireCapability("appointments.configure");
  const cutoff = Math.round(Number(cutoffHours));
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 24 * 30) return { ok: false, error: "Self-service cut-off must be 0–720 hours" };
  const parsed = [];
  for (const [i, r] of rules.entries()) {
    if (!["on_booking", "before", "morning_of"].includes(r.kind)) return { ok: false, error: "Pick when each reminder goes" };
    if (!r.templateId) return { ok: false, error: "Pick a message for each reminder" };
    const channels = r.channels.filter((c) => ["whatsapp", "sms", "email"].includes(c));
    if (!channels.length) return { ok: false, error: "Each reminder needs at least one channel" };
    let minutesBefore: number | null = null;
    let atMin: number | null = null;
    if (r.kind === "before") {
      const h = Number(r.hoursBefore);
      if (!Number.isFinite(h) || h <= 0 || h > 24 * 60) return { ok: false, error: "Hours before must be more than 0" };
      minutesBefore = Math.round(h * 60);
    }
    if (r.kind === "morning_of") {
      atMin = hhmmToMinutes(r.at ?? "");
      if (atMin === null) return { ok: false, error: "Morning-of reminders need a time (HH:MM)" };
    }
    parsed.push({ typeId, kind: r.kind, minutesBefore, atMin, templateId: r.templateId, channels, smsFallback: !!r.smsFallback, quietExempt: !!r.quietExempt, sortOrder: i });
  }
  try {
    await prisma.$transaction([
      prisma.appointmentType.update({ where: { id: typeId }, data: { selfServiceCutoffHours: cutoff } }),
      prisma.reminderRule.deleteMany({ where: { typeId } }),
      prisma.reminderRule.createMany({ data: parsed }),
    ]);
    await audit(actor, "scheduling.reminders.update", typeId, `${parsed.length} reminder(s), cut-off ${cutoff} h`, { meta: { rules: parsed } });
    revalidatePath(PATH);
    // Only NEW bookings pick up a changed timeline; appointments already booked keep the
    // reminders they were given.
    return { ok: true, info: "Saved — applies to appointments booked from now on" };
  } catch (err) {
    return fail("saveReminderSettings", err, "Could not save the reminders");
  }
}

export async function applyReminderPreset(typeId: string, presetKey: string): Promise<Result> {
  await requireCapability("appointments.configure");
  const preset = REMINDER_PRESETS[presetKey];
  if (!preset) return { ok: false, error: "Unknown preset" };
  const templates = await prisma.appointmentMessageTemplate.findMany({ where: { key: { in: preset.rules.map((r) => r.templateKey) } }, select: { id: true, key: true } });
  const byKey = new Map(templates.map((t) => [t.key, t.id]));
  const missing = preset.rules.find((r) => !byKey.has(r.templateKey));
  if (missing) return { ok: false, error: `The "${missing.templateKey}" message is missing — check Messages` };
  return saveReminderSettings(
    typeId,
    preset.cutoffHours,
    preset.rules.map((r) => ({
      kind: r.kind,
      hoursBefore: r.minutesBefore ? r.minutesBefore / 60 : null,
      at: r.atMin != null ? `${String(Math.floor(r.atMin / 60)).padStart(2, "0")}:${String(r.atMin % 60).padStart(2, "0")}` : null,
      templateId: byKey.get(r.templateKey)!,
      channels: r.channels,
      smsFallback: true,
      quietExempt: !!r.quietExempt,
    })),
  );
}
