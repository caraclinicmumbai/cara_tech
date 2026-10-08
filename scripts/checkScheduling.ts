// Self-check for the scheduling engine (§3.2). Two parts:
//
//   1. ENGINE — the pure rules, no database: rooms never double, doctors double only
//      with an acknowledged warning (and only when allowed), branch hours / closures,
//      rosters, leave, support-staff requirements, auto-fill, slot finding — and the
//      spec §2.1 rules: equipment warns, consultation rooms are overridable, OT never,
//      the doctor is always named, and the Rohan Mehta worked example.
//   2. DATABASE — the guarantee under concurrency: fire many simultaneous bookings at
//      one room and confirm exactly one wins; reschedule frees the old slot; status
//      changes release resources. Creates its own fixtures and deletes them after.
//
// Usage: npm run check:scheduling            (both parts)
//        CHECK_DB=0 npm run check:scheduling (engine only)
import assert from "node:assert/strict";
import {
  evaluateSlot,
  explainDay,
  findSlots,
  type DayContext,
  type EngineResource,
  type EngineToggles,
  type Requirement,
} from "../lib/scheduling/engine";
import { istInstant, MINUTE_MS } from "../lib/scheduling/time";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(
    () => {
      passed++;
      console.log(`  ok   ${name}`);
    },
    (err) => {
      console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

// ── Part 1: engine ───────────────────────────────────────────────────────────

const DAY = "2030-01-15"; // a Tuesday, safely in the future
const NOW = istInstant("2030-01-01", 0);
const TOGGLES: EngineToggles = {
  allowDoctorDoubleBooking: true,
  enforceBranchHours: true,
  enforceStaffRosters: true,
  requireSupportStaff: true,
  blockEquipment: false,
};

function res(p: Partial<EngineResource> & Pick<EngineResource, "id" | "kind">): EngineResource {
  return {
    subtype: null,
    name: p.id,
    branchId: "B1",
    active: true,
    sortOrder: 0,
    allowOverride: false,
    rosterHere: [],
    hasRoster: false,
    timeOff: [],
    ...p,
  };
}

function ctx(over: Partial<DayContext> = {}, resources: EngineResource[] = BASE): DayContext {
  return {
    branchId: "B1",
    dateKey: DAY,
    open: [{ startMin: 10 * 60, endMin: 20 * 60 }],
    closures: [],
    resources: new Map(resources.map((r) => [r.id, r])),
    busy: [],
    toggles: TOGGLES,
    ...over,
  };
}

const BASE: EngineResource[] = [
  res({ id: "drA", kind: "doctor", branchId: null }),
  res({ id: "drB", kind: "doctor", branchId: null, sortOrder: 1 }),
  res({ id: "room1", kind: "room", subtype: "consultation", allowOverride: true }),
  res({ id: "ot1", kind: "room", subtype: "ot" }),
  res({ id: "tech1", kind: "staff", subtype: "technician", branchId: null }),
  res({ id: "tech2", kind: "staff", subtype: "technician", branchId: null }),
  res({ id: "otherRoom", kind: "room", subtype: "consultation", branchId: "B2" }),
  res({ id: "laser1", kind: "equipment", subtype: "laser" }),
];

const CONSULT: Requirement[] = [
  { kind: "doctor", subtype: null, resourceId: null, quantity: 1 },
  { kind: "room", subtype: "consultation", resourceId: null, quantity: 1 },
];
const FUE: Requirement[] = [
  { kind: "doctor", subtype: null, resourceId: null, quantity: 1 },
  { kind: "room", subtype: "ot", resourceId: null, quantity: 1 },
  { kind: "staff", subtype: "technician", resourceId: null, quantity: 2 },
];

function slot(startMin: number, durationMin: number, extra: Partial<Parameters<typeof evaluateSlot>[1]> = {}) {
  const startAt = istInstant(DAY, startMin);
  const endAt = new Date(startAt.getTime() + durationMin * MINUTE_MS);
  return { startAt, endAt, holdUntil: endAt, requirements: CONSULT, chosenIds: [], now: NOW, ...extra };
}

function busy(resourceId: string, startMin: number, endMin: number, appointmentId = "existing") {
  return { resourceId, appointmentId, startAt: istInstant(DAY, startMin), endAt: istInstant(DAY, endMin) };
}

async function engineChecks() {
  console.log("Engine");

  await check("free slot books with the chosen doctor + an auto-filled room", () => {
    const r = evaluateSlot(ctx(), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, false);
    assert.deepEqual(r.resourceIds.sort(), ["drA", "room1"]);
  });

  await check("room is NEVER double-booked", () => {
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(11 * 60 + 30, 30, { chosenIds: ["room1"] }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "double_booked" && i.resourceId === "room1"));
  });

  await check("room clash with no room chosen → requirement unfilled", () => {
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "requirement_unfilled"));
  });

  await check("back-to-back is not a clash (half-open intervals)", () => {
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(12 * 60, 30, { chosenIds: ["drA", "room1"] }));
    assert.equal(r.ok, true);
  });

  await check("chosen doctor already booked → warning needing acknowledgement", () => {
    const r = evaluateSlot(ctx({ busy: [busy("drA", 11 * 60, 12 * 60)] }), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, true);
    assert.ok(r.issues.some((i) => i.code === "doctor_overbooked"));
  });

  await check("doctor double-booking OFF → doctor blocks like a room", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("drA", 11 * 60, 12 * 60)], toggles: { ...TOGGLES, allowDoctorDoubleBooking: false } }),
      slot(11 * 60, 30, { chosenIds: ["drA"] }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "double_booked" && i.resourceId === "drA"));
  });

  await check("the doctor is never auto-picked (patients book a named surgeon)", () => {
    const r = evaluateSlot(ctx(), slot(11 * 60, 30));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "doctor_not_chosen"));
  });

  await check("rescheduling ignores the appointment's own current slot", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("room1", 11 * 60, 12 * 60, "me")] }),
      slot(11 * 60 + 15, 30, { chosenIds: ["drA", "room1"], ignoreAppointmentIds: ["me"] }),
    );
    assert.equal(r.ok, true);
  });

  await check("turnover buffer keeps the room blocked after the patient leaves", () => {
    const c = ctx({ busy: [busy("ot1", 11 * 60, 12 * 60 + 30)] }); // 60 min + 30 buffer
    const r = evaluateSlot(c, slot(12 * 60 + 15, 30, { requirements: FUE, chosenIds: ["drA", "ot1"] }));
    assert.equal(r.ok, false);
  });

  await check("outside branch hours is blocked", () => {
    const r = evaluateSlot(ctx(), slot(19 * 60 + 45, 30, { chosenIds: ["drA"] }));
    assert.ok(r.issues.some((i) => i.code === "outside_hours" && i.severity === "block"));
  });

  await check("branch hours not enforced → only a warning", () => {
    const r = evaluateSlot(ctx({ toggles: { ...TOGGLES, enforceBranchHours: false } }), slot(19 * 60 + 45, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, true);
    assert.ok(r.issues.some((i) => i.code === "outside_hours" && i.severity === "warn"));
  });

  await check("closed day (holiday) is blocked", () => {
    const r = evaluateSlot(ctx({ open: [], closures: [{ startMin: 0, endMin: 1440, reason: "Diwali" }] }), slot(11 * 60, 30));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "branch_closed"));
  });

  await check("partial closure blocks only its hours", () => {
    const c = ctx({ closures: [{ startMin: 14 * 60, endMin: 16 * 60, reason: "Maintenance" }] });
    assert.equal(evaluateSlot(c, slot(14 * 60 + 30, 30, { chosenIds: ["drA"] })).ok, false);
    assert.equal(evaluateSlot(c, slot(11 * 60, 30, { chosenIds: ["drA"] })).ok, true);
  });

  await check("rostered doctor is only bookable inside the roster", () => {
    const rostered = BASE.map((r) =>
      r.id === "drA" ? { ...r, hasRoster: true, rosterHere: [{ startMin: 10 * 60, endMin: 14 * 60 }] } : r,
    );
    const inside = evaluateSlot(ctx({}, rostered), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    const outside = evaluateSlot(ctx({}, rostered), slot(15 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(inside.ok, true);
    assert.equal(outside.ok, false);
    assert.ok(outside.issues.some((i) => i.code === "off_roster"));
  });

  await check("doctor on leave is blocked", () => {
    const onLeave = BASE.map((r) =>
      r.id === "drA" ? { ...r, timeOff: [{ startAt: istInstant(DAY, 0), endAt: istInstant(DAY, 1440), reason: "Leave" }] } : r,
    );
    const r = evaluateSlot(ctx({}, onLeave), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "time_off"));
  });

  await check("FUE reserves doctor + OT + two technicians", () => {
    const r = evaluateSlot(ctx(), slot(10 * 60, 8 * 60, { requirements: FUE, chosenIds: ["drA"] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.resourceIds.sort(), ["drA", "ot1", "tech1", "tech2"]);
  });

  await check("FUE refused when the technician team isn't free", () => {
    const r = evaluateSlot(ctx({ busy: [busy("tech2", 12 * 60, 13 * 60)] }), slot(10 * 60, 8 * 60, { requirements: FUE, chosenIds: ["drA"] }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "requirement_unfilled" && i.message.includes("technician")));
  });

  await check("support-staff scheduling OFF → staff requirement ignored", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("tech2", 12 * 60, 13 * 60)], toggles: { ...TOGGLES, requireSupportStaff: false } }),
      slot(10 * 60, 8 * 60, { requirements: FUE, chosenIds: ["drA"] }),
    );
    assert.equal(r.ok, true);
  });

  await check("a room in another branch can't be used", () => {
    const r = evaluateSlot(ctx(), slot(11 * 60, 30, { chosenIds: ["otherRoom"] }));
    assert.ok(r.issues.some((i) => i.code === "wrong_branch"));
  });

  await check("past start is refused unless back-dating is allowed", () => {
    const later = istInstant(DAY, 12 * 60);
    assert.equal(evaluateSlot(ctx(), slot(11 * 60, 30, { now: later, chosenIds: ["drA"] })).ok, false);
    assert.equal(evaluateSlot(ctx(), slot(11 * 60, 30, { now: later, allowPast: true, chosenIds: ["drA"] })).ok, true);
  });

  await check("findSlots skips taken times and respects hours", () => {
    const c = ctx({ busy: [busy("room1", 10 * 60, 19 * 60)] });
    const slots = findSlots(c, { durationMin: 30, bufferAfterMin: 0, requirements: CONSULT, chosenIds: ["drA"], stepMin: 30, now: NOW, istInstant });
    // room1 is the only consultation room in B1; free 19:00–20:00 → 19:00 and 19:30.
    assert.deepEqual(slots.map((s) => s.startAt.getTime()), [istInstant(DAY, 19 * 60).getTime(), istInstant(DAY, 19 * 60 + 30).getTime()]);
  });
}

async function spec21Checks() {
  console.log("Spec 2.1 — rooms & OT team block; doctors & equipment warn");

  const LASER: Requirement[] = [
    { kind: "doctor", subtype: null, resourceId: null, quantity: 1 },
    { kind: "room", subtype: "consultation", resourceId: null, quantity: 1 },
    { kind: "equipment", subtype: "laser", resourceId: null, quantity: 1 },
  ];

  await check("equipment in use → warning to acknowledge, not a block", () => {
    const r = evaluateSlot(ctx({ busy: [busy("laser1", 11 * 60, 12 * 60)] }), slot(11 * 60, 30, { requirements: LASER, chosenIds: ["drA", "laser1"] }));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, true);
    assert.ok(r.issues.some((i) => i.code === "equipment_overbooked"));
  });

  await check("a NAMED machine in use (type requirement, not chosen) still only warns", () => {
    const named: Requirement[] = [
      { kind: "doctor", subtype: null, resourceId: null, quantity: 1 },
      { kind: "equipment", subtype: null, resourceId: "laser1", quantity: 1 },
    ];
    const r = evaluateSlot(ctx({ busy: [busy("laser1", 11 * 60, 12 * 60)] }), slot(11 * 60, 30, { requirements: named, chosenIds: ["drA"] }));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, true);
    assert.ok(r.resourceIds.includes("laser1"));
  });

  await check("'Block equipment' switch ON → equipment blocks like a room", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("laser1", 11 * 60, 12 * 60)], toggles: { ...TOGGLES, blockEquipment: true } }),
      slot(11 * 60, 30, { requirements: LASER, chosenIds: ["drA", "laser1"] }),
    );
    assert.equal(r.ok, false);
  });

  await check("equipment under maintenance → warning when equipment isn't blocked", () => {
    const down = BASE.map((x) => (x.id === "laser1" ? { ...x, timeOff: [{ startAt: istInstant(DAY, 0), endAt: istInstant(DAY, 1440), reason: "Calibration" }] } : x));
    const r = evaluateSlot(ctx({}, down), slot(11 * 60, 30, { requirements: LASER, chosenIds: ["drA", "laser1"] }));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, true);
  });

  await check("consultation-room clash is blocked but overridable…", () => {
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(11 * 60, 30, { chosenIds: ["drA", "room1"] }));
    assert.equal(r.ok, false);
    assert.equal(r.overridable, true);
  });

  await check("…and a branch-manager override lets it through, marked", () => {
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(11 * 60, 30, { chosenIds: ["drA", "room1"], override: true }));
    assert.equal(r.ok, true);
    assert.ok(r.issues.some((i) => i.code === "room_overridden"));
  });

  await check("an OT clash can NEVER be overridden", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("ot1", 10 * 60, 12 * 60)] }),
      slot(10 * 60, 8 * 60, { requirements: FUE, chosenIds: ["drA", "ot1"], override: true }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.overridable, false);
  });

  await check("an OT-team clash can NEVER be overridden", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("tech1", 10 * 60, 12 * 60)] }),
      slot(10 * 60, 8 * 60, { requirements: FUE, chosenIds: ["drA", "tech1"], override: true }),
    );
    assert.equal(r.ok, false);
  });

  // The spec's worked example, under the clinic's decisions: Rohan Mehta, FUE, 8h +
  // 45 min OT turnover, Dr Asif, OT-1, device set A, 3 technicians. Saturday: the
  // device is busy 08:00–12:00 (now only a warning) and only 2 of 3 technicians are
  // free after 13:00 (still a block). Sunday: all free.
  const SAT = "2030-01-19";
  const SUN = "2030-01-20";
  const rohanRes: EngineResource[] = [
    res({ id: "drAsif", name: "Dr Asif", kind: "doctor", branchId: null }),
    res({ id: "ot1", name: "OT-1", kind: "room", subtype: "ot" }),
    res({ id: "ot2", name: "OT-2", kind: "room", subtype: "ot" }),
    res({ id: "devA", name: "Extraction device set A", kind: "equipment", subtype: "extraction" }),
    res({ id: "t1", name: "Tech 1", kind: "staff", subtype: "technician", branchId: null }),
    res({ id: "t2", name: "Tech 2", kind: "staff", subtype: "technician", branchId: null }),
    res({ id: "t3", name: "Tech 3", kind: "staff", subtype: "technician", branchId: null }),
  ];
  const FUE3: Requirement[] = [
    { kind: "doctor", subtype: null, resourceId: null, quantity: 1 },
    { kind: "room", subtype: null, resourceId: "ot1", quantity: 1 },
    { kind: "equipment", subtype: null, resourceId: "devA", quantity: 1 },
    { kind: "staff", subtype: "technician", resourceId: null, quantity: 3 },
  ];
  const satBusy = [
    { resourceId: "devA", appointmentId: "other", startAt: istInstant(SAT, 8 * 60), endAt: istInstant(SAT, 12 * 60) },
    { resourceId: "t3", appointmentId: "other2", startAt: istInstant(SAT, 13 * 60), endAt: istInstant(SAT, 18 * 60) },
  ];
  const day = (dateKey: string, busyRows: typeof satBusy) =>
    ctx({ dateKey, open: [{ startMin: 8 * 60, endMin: 20 * 60 }], busy: busyRows }, rohanRes);
  const fueOpts = { durationMin: 8 * 60, bufferAfterMin: 45, requirements: FUE3, chosenIds: ["drAsif"], stepMin: 60, now: NOW, istInstant };

  await check("worked example: Saturday offers no slot, and says why", () => {
    const c = day(SAT, satBusy);
    assert.equal(findSlots(c, fueOpts).length, 0);
    const why = explainDay(c, fueOpts);
    assert.ok(why.some((m) => m.includes("technician") && m.includes("only 2 free")), why.join(" | "));
  });

  await check("worked example: Sunday 08:00 works, holding everyone to 16:45", () => {
    const slots = findSlots(day(SUN, []), fueOpts);
    assert.ok(slots.length > 0);
    assert.equal(slots[0].startAt.getTime(), istInstant(SUN, 8 * 60).getTime());
    assert.deepEqual([...slots[0].resourceIds].sort(), ["devA", "drAsif", "ot1", "t1", "t2", "t3"]);
  });

  await check("explainDay on a holiday says only that", () => {
    const why = explainDay(ctx({ open: [], closures: [{ startMin: 0, endMin: 1440, reason: "Diwali" }] }), fueOpts);
    assert.deepEqual(why, ["Branch closed: Diwali"]);
  });
}

// ── Part 2: database ─────────────────────────────────────────────────────────

async function dbChecks() {
  console.log("Database");
  const { prisma } = await import("../lib/prisma");
  const { bookAppointment, rescheduleAppointment, changeAppointmentStatus } = await import("../lib/scheduling/booking");
  const tag = `chk-${Date.now()}`;
  const actor = { id: null, email: "check@scheduling" };

  const branch = await prisma.branch.create({ data: { code: `T${String(Date.now()).slice(-6)}`, name: `${tag} branch` } });
  const lead = await prisma.lead.create({ data: { name: `${tag} patient`, phone: "+910000000000", source: "manual" } });
  const room = await prisma.resource.create({ data: { kind: "room", subtype: "consultation", name: `${tag} room`, branchId: branch.id } });
  const doctor = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} doctor` } });
  const type = await prisma.appointmentType.create({
    data: {
      name: `${tag} consult`,
      durationMin: 30,
      requirements: {
        create: [
          { kind: "room", subtype: "consultation", resourceId: room.id },
          { kind: "doctor", resourceId: doctor.id },
        ],
      },
    },
  });

  // The day after tomorrow at 11:00 IST — inside default hours, never in the past.
  const d = new Date(Date.now() + 2 * 86_400_000);
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
  const at = (min: number) => istInstant(dateKey, min);
  const base = { leadId: lead.id, branchId: branch.id, typeId: type.id };

  const extraTypes: string[] = [];
  const extraResources: string[] = [];

  try {
    await check("12 simultaneous bookings of one room → exactly one wins", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => bookAppointment({ ...base, startAt: at(11 * 60), acknowledgeWarnings: true }, actor)),
      );
      const wins = results.filter((r) => r.ok);
      assert.equal(wins.length, 1, `expected 1 winner, got ${wins.length}`);
      // §2.1: "the other is told the slot was just taken".
      const told = results.filter((r) => !r.ok && r.justTaken);
      assert.ok(told.length >= 1, "at least one loser should be told the slot was just taken");
      const rows = await prisma.appointmentResource.count({ where: { resourceId: room.id, blocking: true } });
      assert.equal(rows, 1);
    });

    let movedId = "";
    await check("reschedule keeps the old row, links the new, frees the old slot", async () => {
      const first = await prisma.appointment.findFirstOrThrow({ where: { typeId: type.id, status: "booked" } });
      const r = await rescheduleAppointment(first.id, { startAt: at(13 * 60), reason: "patient asked" }, actor);
      assert.ok(r.ok, !r.ok ? r.error : "");
      movedId = r.ok ? r.appointmentId : "";
      const old = await prisma.appointment.findUniqueOrThrow({ where: { id: first.id } });
      const next = await prisma.appointment.findUniqueOrThrow({ where: { id: movedId } });
      assert.equal(old.status, "rescheduled");
      assert.equal(next.rescheduledFromId, first.id);
      const again = await bookAppointment({ ...base, startAt: at(11 * 60) }, actor);
      assert.ok(again.ok, "the freed 11:00 slot should be bookable again");
    });

    await check("illegal transition refused; check-in → complete allowed", async () => {
      const bad = await changeAppointmentStatus(movedId, "completed", {}, actor);
      assert.equal(bad.ok, false);
      assert.ok((await changeAppointmentStatus(movedId, "checked_in", {}, actor)).ok);
      assert.ok((await changeAppointmentStatus(movedId, "completed", {}, actor)).ok);
    });

    await check("cancel needs a reason, then frees the room", async () => {
      const a = await prisma.appointment.findFirstOrThrow({ where: { typeId: type.id, status: "booked" } });
      assert.equal((await changeAppointmentStatus(a.id, "cancelled", {}, actor)).ok, false);
      assert.ok((await changeAppointmentStatus(a.id, "cancelled", { reason: "unwell", cancelledBy: "patient" }, actor)).ok);
      const blocking = await prisma.appointmentResource.count({ where: { appointmentId: a.id, blocking: true } });
      assert.equal(blocking, 0);
    });

    // Fixtures for the §2.1 checks: two consultation rooms (B overridable), and a type
    // that takes ANY consultation room with a named doctor.
    const roomA = await prisma.resource.create({ data: { kind: "room", subtype: "consult2", name: `${tag} room A`, branchId: branch.id, sortOrder: 0 } });
    const roomB = await prisma.resource.create({ data: { kind: "room", subtype: "consult2", name: `${tag} room B`, branchId: branch.id, sortOrder: 1, allowOverride: true } });
    const anyRoom = await prisma.appointmentType.create({
      data: {
        name: `${tag} any-room consult`,
        durationMin: 30,
        requirements: { create: [{ kind: "doctor" }, { kind: "room", subtype: "consult2" }] },
      },
    });
    extraTypes.push(anyRoom.id);
    extraResources.push(roomA.id, roomB.id);
    const b2 = { leadId: lead.id, branchId: branch.id, typeId: anyRoom.id, resourceIds: [doctor.id], acknowledgeWarnings: true };

    await check("reschedule re-allocates the room instead of assuming the old one", async () => {
      const first = await bookAppointment({ ...b2, startAt: at(15 * 60) }, actor);
      assert.ok(first.ok);
      const firstRoom = await prisma.appointmentResource.findFirstOrThrow({
        where: { appointmentId: first.ok ? first.appointmentId : "", resource: { kind: "room" } },
      });
      assert.equal(firstRoom.resourceId, roomA.id);
      // Someone else takes room A at 16:00.
      const blocker = await bookAppointment({ ...b2, startAt: at(16 * 60), resourceIds: [doctor.id, roomA.id] }, actor);
      assert.ok(blocker.ok, !blocker.ok ? blocker.error : "");
      const moved = await rescheduleAppointment(first.ok ? first.appointmentId : "", { startAt: at(16 * 60), acknowledgeWarnings: true }, actor);
      assert.ok(moved.ok, !moved.ok ? moved.error : "");
      const newRoom = await prisma.appointmentResource.findFirstOrThrow({
        where: { appointmentId: moved.ok ? moved.appointmentId : "", resource: { kind: "room" } },
      });
      assert.equal(newRoom.resourceId, roomB.id);
    });

    await check("consultation-room clash: refused as overridable, then booked with a logged override", async () => {
      // Room B is now taken 16:00–16:30 by the rescheduled appointment.
      const refused = await bookAppointment({ ...b2, startAt: at(16 * 60), resourceIds: [doctor.id, roomB.id] }, actor);
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.overridable, true);
      const noReason = await bookAppointment({ ...b2, startAt: at(16 * 60), resourceIds: [doctor.id, roomB.id], override: { reason: " " } }, actor);
      assert.equal(noReason.ok, false);
      const forced = await bookAppointment(
        { ...b2, startAt: at(16 * 60), resourceIds: [doctor.id, roomB.id], override: { reason: "VIP follow-up, 5 min" } },
        actor,
      );
      assert.ok(forced.ok, !forced.ok ? forced.error : "");
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id: forced.ok ? forced.appointmentId : "" } });
      assert.equal(row.overrideReason, "VIP follow-up, 5 min");
      const audit = await prisma.auditLog.count({ where: { entityId: row.id, action: "appointment.book.override" } });
      assert.equal(audit, 1);
    });

    await check("every write left an audit row", async () => {
      const ids = (await prisma.appointment.findMany({ where: { typeId: type.id }, select: { id: true } })).map((a) => a.id);
      const n = await prisma.auditLog.count({ where: { entityType: "appointment", entityId: { in: ids } } });
      assert.ok(n >= 6, `expected ≥6 audit rows, got ${n}`);
    });
  } finally {
    await prisma.appointment.deleteMany({ where: { typeId: { in: [type.id, ...extraTypes] } } });
    await prisma.appointmentType.deleteMany({ where: { id: { in: [type.id, ...extraTypes] } } });
    await prisma.resource.deleteMany({ where: { id: { in: [room.id, doctor.id, ...extraResources] } } });
    await prisma.lead.delete({ where: { id: lead.id } });
    await prisma.branch.delete({ where: { id: branch.id } });
    await prisma.$disconnect();
  }
}

(async () => {
  await engineChecks();
  await spec21Checks();
  if (process.env.CHECK_DB !== "0") await dbChecks();
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})();
