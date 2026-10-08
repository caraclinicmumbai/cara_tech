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
  return Promise.resolve()
    .then(fn)
    .then(
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
    travelMinutes: (a: string, b: string) => (a === b ? 0 : 120),
    branchNames: new Map([["B1", "Andheri"], ["B2", "Powai"]]),
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

function busy(resourceId: string, startMin: number, endMin: number, appointmentId = "existing", branchId = "B1") {
  return { resourceId, appointmentId, branchId, startAt: istInstant(DAY, startMin), endAt: istInstant(DAY, endMin) };
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
    { resourceId: "devA", appointmentId: "other", branchId: "B1", startAt: istInstant(SAT, 8 * 60), endAt: istInstant(SAT, 12 * 60) },
    { resourceId: "t3", appointmentId: "other2", branchId: "B1", startAt: istInstant(SAT, 13 * 60), endAt: istInstant(SAT, 18 * 60) },
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

async function spec22Checks() {
  console.log("Spec 2.2 — one person, one calendar, across branches");
  // ctx() is branch B1 = Andheri; B2 = Powai; travel between them = 120 min.

  await check("doctor booked at Powai can't be at Andheri at the same time (even with double-booking allowed)", () => {
    const r = evaluateSlot(ctx({ busy: [busy("drA", 10 * 60, 11 * 60, "p", "B2")] }), slot(10 * 60 + 30, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "elsewhere" && i.message.includes("Powai")));
  });

  await check("…and not within the travel time either side", () => {
    const c = ctx({ busy: [busy("drA", 10 * 60, 12 * 60, "p", "B2")] });
    const tooSoon = evaluateSlot(c, slot(13 * 60, 30, { chosenIds: ["drA"] })); // 60 min after
    const fine = evaluateSlot(c, slot(14 * 60, 30, { chosenIds: ["drA"] })); // 120 min after
    const beforeTooLate = evaluateSlot(c, slot(8 * 60 + 30, 30, { chosenIds: ["drA"], allowPast: true, now: NOW })); // ends 9:00, Powai at 10
    assert.equal(tooSoon.ok, false);
    assert.ok(tooSoon.issues.some((i) => i.code === "travel_time"));
    assert.equal(fine.ok, true);
    assert.ok(beforeTooLate.issues.some((i) => i.code === "travel_time"));
  });

  await check("same-branch doctor overlap is still only a warning", () => {
    const r = evaluateSlot(ctx({ busy: [busy("drA", 10 * 60, 11 * 60, "p", "B1")] }), slot(10 * 60 + 30, 30, { chosenIds: ["drA"] }));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, true);
  });

  await check("OT-team member at another branch is blocked too", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("tech1", 10 * 60, 12 * 60, "p", "B2")] }),
      slot(10 * 60, 8 * 60, { requirements: FUE, chosenIds: ["drA", "tech1"] }),
    );
    assert.ok(r.issues.some((i) => i.code === "elsewhere" && i.resourceId === "tech1"));
  });

  // Worked example: Dr Asif Sat — Andheri 09:00–13:00, Powai 15:00–18:00.
  const satAtPowai = (busyRows: ReturnType<typeof busy>[]) =>
    ctx(
      { branchId: "B2", open: [{ startMin: 9 * 60, endMin: 20 * 60 }], busy: busyRows },
      BASE.map((x) => (x.id === "drA" ? { ...x, hasRoster: true, rosterHere: [{ startMin: 15 * 60, endMin: 18 * 60 }] } : x)).concat([
        res({ id: "powaiRoom", kind: "room", subtype: "consultation", branchId: "B2" }),
      ]),
    );

  await check("worked example: 13:30 at Powai is not offered (he's travelling)", () => {
    const r = evaluateSlot(satAtPowai([]), slot(13 * 60 + 30, 15, { chosenIds: ["drA"] }));
    assert.equal(r.ok, false);
  });

  await check("worked example: 15:00 at Powai works after an Andheri patient until 13:00", () => {
    const r = evaluateSlot(satAtPowai([busy("drA", 12 * 60 + 30, 13 * 60, "a", "B1")]), slot(15 * 60, 15, { chosenIds: ["drA"] }));
    assert.equal(r.ok, true, r.issues.map((i) => i.message).join(" | "));
  });

  await check("worked example: an Andheri patient running to 14:00 pushes Powai's first slot to 16:00", () => {
    const c = satAtPowai([busy("drA", 13 * 60 + 30, 14 * 60, "a", "B1")]);
    const slots = findSlots(c, { durationMin: 15, bufferAfterMin: 0, requirements: CONSULT, chosenIds: ["drA"], stepMin: 30, now: NOW, istInstant });
    assert.equal(slots[0].startAt.getTime(), istInstant(DAY, 16 * 60).getTime());
  });
}

async function spec29Checks() {
  console.log("Spec 2.9 — leave and visiting doctors (engine)");
  await check("requested (unapproved) leave warns and needs acknowledgement, doesn't block", () => {
    const r = BASE.map((x) =>
      x.id === "drA" ? { ...x, timeOff: [{ startAt: istInstant(DAY, 0), endAt: istInstant(DAY, 1440), reason: "Conference", tentative: true }] } : x,
    );
    const out = evaluateSlot(ctx({}, r), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(out.ok, true);
    assert.equal(out.needsAck, true);
    assert.ok(out.issues.some((i) => i.code === "leave_requested"));
  });
  await check("visiting doctor can't be booked outside their contract dates", () => {
    const r = BASE.map((x) => (x.id === "drA" ? { ...x, contractFrom: "2030-02-01", contractUntil: "2030-03-31" } : x));
    const out = evaluateSlot(ctx({}, r), slot(11 * 60, 30, { chosenIds: ["drA"] }));
    assert.equal(out.ok, false);
    assert.ok(out.issues.some((i) => i.code === "contract"));
  });
}

async function spec24Checks() {
  console.log("Spec 2.4 — reminders (pure)");
  const { dueTime } = await import("../lib/scheduling/reminders");
  const { fillTemplate } = await import("../lib/scheduling/messageText");
  const { appointmentToken, verifyAppointmentToken } = await import("../lib/scheduling/links");
  const q = { start: 21 * 60, end: 8 * 60 };
  const now = istInstant("2030-01-10", 10 * 60);
  const start = istInstant(DAY, 9 * 60); // 15 Jan 09:00

  await check("24 h-before reminder landing at 09:00 goes at 09:00", () => {
    const d = dueTime({ kind: "before", minutesBefore: 24 * 60, atMin: null, quietExempt: false }, start, now, q);
    assert.equal(d?.getTime(), istInstant("2030-01-14", 9 * 60).getTime());
  });
  await check("a reminder falling in quiet hours waits until 08:00", () => {
    const d = dueTime({ kind: "before", minutesBefore: 12 * 60, atMin: null, quietExempt: false }, start, now, q); // 21:00 the night before
    assert.equal(d?.getTime(), istInstant(DAY, 8 * 60).getTime());
  });
  await check("the quiet-exempt morning-of reminder goes at 06:30", () => {
    const d = dueTime({ kind: "morning_of", minutesBefore: null, atMin: 6 * 60 + 30, quietExempt: true }, start, now, q);
    assert.equal(d?.getTime(), istInstant(DAY, 6 * 60 + 30).getTime());
  });
  await check("a reminder whose moment already passed (booked late) is not created", () => {
    const lateNow = istInstant(DAY, 8 * 60);
    assert.equal(dueTime({ kind: "before", minutesBefore: 24 * 60, atMin: null, quietExempt: false }, start, lateNow, q), null);
  });
  await check("held by quiet hours past the appointment → not sent", () => {
    const early = istInstant(DAY, 7 * 60 + 30);
    const d = dueTime({ kind: "before", minutesBefore: 60, atMin: null, quietExempt: false }, early, now, q); // 06:30 → held to 08:00, after start
    assert.equal(d, null);
  });
  await check("templates fill placeholders and drop lines left empty", () => {
    const out = fillTemplate("Hi {patient_name},\n{prep}\nSee you {time}. {unknown}", { patient_name: "Priya", prep: "", time: "4 PM" });
    assert.equal(out, "Hi Priya,\nSee you 4 PM. {unknown}");
  });
  await check("patient links verify, and refuse tampering and expiry", () => {
    const t = appointmentToken("appt123", new Date(Date.now() + 3600_000));
    assert.equal(verifyAppointmentToken(t)?.appointmentId, "appt123");
    assert.equal(verifyAppointmentToken(t.replace("appt123", "appt124")), null);
    const old = appointmentToken("appt123", new Date(Date.now() - 1000));
    assert.equal(verifyAppointmentToken(old), null);
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
  const extraBranches: string[] = [];

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

    // §2.2 — one-off roster changes and privacy, against the real loaders.
    const branch2 = await prisma.branch.create({ data: { code: `U${String(Date.now()).slice(-6)}`, name: `${tag} branch 2` } });
    extraBranches.push(branch2.id);
    const roomB2 = await prisma.resource.create({ data: { kind: "room", subtype: "consult2", name: `${tag} room B2`, branchId: branch2.id } });
    extraResources.push(roomB2.id);
    const rotating = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} rotating doctor` } });
    extraResources.push(rotating.id);
    const { weekdayOfKey, dateColumn } = await import("../lib/scheduling/time");
    // Weekly: this weekday at branch 1 only.
    await prisma.resourceSchedule.create({ data: { resourceId: rotating.id, branchId: branch.id, weekday: weekdayOfKey(dateKey), startMin: 10 * 60, endMin: 17 * 60 } });
    const b3 = { leadId: lead.id, branchId: branch2.id, typeId: anyRoom.id, resourceIds: [rotating.id] };

    await check("doctor rostered at branch 1 can't be booked at branch 2 that day", async () => {
      const r = await bookAppointment({ ...b3, startAt: at(11 * 60) }, actor);
      assert.equal(r.ok, false);
    });

    await check("a one-off change moves them to branch 2 for that date (replacing the weekly roster)", async () => {
      await prisma.resourceScheduleException.create({
        data: { resourceId: rotating.id, date: dateColumn(dateKey), branchId: branch2.id, startMin: 10 * 60, endMin: 17 * 60 },
      });
      const atB2 = await bookAppointment({ ...b3, startAt: at(11 * 60) }, actor);
      assert.ok(atB2.ok, !atB2.ok ? atB2.error : "");
      const atB1 = await bookAppointment({ ...b2, resourceIds: [rotating.id], startAt: at(14 * 60) }, actor);
      assert.equal(atB1.ok, false, "branch 1 is no longer on their roster that day");
    });

    await check("other branch's appointments are masked for a viewer without all-branch access", async () => {
      const { loadAppointments } = await import("../lib/scheduling/calendar");
      const from = at(0);
      const to = at(24 * 60);
      const base = { id: null, role: "front_desk", resourceId: null, bookAnyBranch: false, canBook: true, canCheckin: true, canOverride: false };
      const fromB1 = await loadAppointments({ ...base, homeBranchId: branch.id, seesAllBranches: false }, from, to, { branchId: branch2.id });
      assert.ok(fromB1.length >= 1);
      assert.ok(fromB1.every((a) => !a.visible && a.patientName === null && a.typeName === null && a.notes === null));
      const fromB2 = await loadAppointments({ ...base, homeBranchId: branch2.id, seesAllBranches: false }, from, to, { branchId: branch2.id });
      assert.ok(fromB2.every((a) => a.visible && a.patientName !== null));
      const asDoctor = await loadAppointments({ ...base, homeBranchId: branch.id, seesAllBranches: false, resourceId: rotating.id }, from, to, { branchId: null });
      assert.ok(asDoctor.filter((a) => a.resources.some((x) => x.id === rotating.id)).every((a) => a.visible), "a doctor sees their own appointments everywhere");
    });

    // §2.9 — leave approval, rebooking cases, suggestions, emergency.
    const leave = await import("../lib/scheduling/leave");
    const conflicts = await import("../lib/scheduling/conflicts");
    const drX = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} leave doctor` } });
    const drY = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} cover doctor` } });
    extraResources.push(drX.id, drY.id);
    const b4 = { leadId: lead.id, branchId: branch.id, typeId: anyRoom.id, acknowledgeWarnings: true };
    const booked = await bookAppointment({ ...b4, resourceIds: [drX.id], startAt: at(17 * 60) }, actor);
    const bookedId = booked.ok ? booked.appointmentId : "";
    let leaveId = "";

    await check("a leave REQUEST doesn't open cases; approving it does, and never cancels the appointment", async () => {
      assert.ok(booked.ok, !booked.ok ? booked.error : "");
      const req = await leave.requestLeave({ resourceId: drX.id, startAt: at(0), endAt: at(24 * 60), kind: "conference", reason: "Conference" }, actor);
      assert.ok(req.ok && req.id);
      leaveId = req.id!;
      assert.equal(await prisma.rebookingCase.count({ where: { appointmentId: bookedId } }), 0);
      const dec = await leave.decideLeave(leaveId, true, null, actor);
      assert.ok(dec.ok);
      assert.equal(dec.affected, 1);
      const c = await prisma.rebookingCase.findFirstOrThrow({ where: { appointmentId: bookedId } });
      assert.equal(c.status, "open");
      const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: bookedId } });
      assert.equal(appt.status, "booked", "the system never cancels on its own");
    });

    await check("approved leave blocks new bookings for that doctor", async () => {
      const r = await bookAppointment({ ...b4, resourceIds: [drX.id], startAt: at(10 * 60) }, actor);
      assert.equal(r.ok, false);
    });

    await check("withdrawing the leave closes the case it opened", async () => {
      await leave.cancelLeave(leaveId, actor);
      const c = await prisma.rebookingCase.findFirstOrThrow({ where: { appointmentId: bookedId } });
      assert.equal(c.status, "dismissed");
    });

    await check("rebooking helper suggests another doctor at the same time, and applying it moves the appointment", async () => {
      const again = await leave.requestLeave({ resourceId: drX.id, startAt: at(0), endAt: at(24 * 60), kind: "leave", reason: "Leave", approveNow: true }, actor);
      assert.ok(again.ok);
      const c = await prisma.rebookingCase.findFirstOrThrow({ where: { appointmentId: bookedId, status: "open" } });
      const opts = await conflicts.suggestAlternatives(c.id);
      const cover = opts.find((o) => o.kind === "other_doctor_same_time" && o.doctorId === drY.id);
      assert.ok(cover, `expected cover doctor among ${opts.map((o) => o.label).join(", ")}`);
      const applied = await conflicts.applyAlternative(c.id, { branchId: cover!.branchId, doctorId: cover!.doctorId, startAt: cover!.startAt }, actor);
      assert.ok(applied.ok, applied.error);
      await conflicts.recheckOpenCases({}); // the worklist page runs this on every load
      const after = await prisma.rebookingCase.findUniqueOrThrow({ where: { id: c.id } });
      assert.equal(after.status, "proposed", "a moved case waits for the patient's confirmation");
      const moved = await prisma.appointment.findUniqueOrThrow({ where: { id: after.newAppointmentId! }, include: { resources: true } });
      assert.ok(moved.resources.some((r) => r.resourceId === drY.id));
    });

    await check("emergency: urgent case, and the doctor is blocked for the rest of the day", async () => {
      const drZ = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} emergency doctor` } });
      extraResources.push(drZ.id);
      const z = await bookAppointment({ ...b4, resourceIds: [drZ.id], startAt: at(18 * 60) }, actor);
      assert.ok(z.ok);
      const e = await leave.markEmergency(drZ.id, "Unwell", actor, at(9 * 60));
      assert.ok(e.ok);
      const c = await prisma.rebookingCase.findFirstOrThrow({ where: { appointmentId: z.ok ? z.appointmentId : "" } });
      assert.equal(c.urgent, true);
      assert.equal(c.cause, "emergency");
    });

    await check("a holiday added over booked dates puts those appointments on the rebooking list", async () => {
      const drH = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} holiday doctor` } });
      extraResources.push(drH.id);
      const h = await bookAppointment({ ...b4, resourceIds: [drH.id], startAt: at(19 * 60) }, actor);
      assert.ok(h.ok);
      const n = await conflicts.detectClosure({ branchId: branch.id, startDateKey: dateKey, endDateKey: dateKey, startMin: null, endMin: null, reason: "Diwali" });
      assert.ok(n >= 1);
      const c = await prisma.rebookingCase.findFirstOrThrow({ where: { appointmentId: h.ok ? h.appointmentId : "" } });
      assert.equal(c.cause, "closure");
    });

    // §2.4 — reminders against the database. WhatsApp is blanked for this process so
    // no check can ever message a real number.
    process.env.WHATSAPP_TOKEN = "";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "";
    const reminders = await import("../lib/scheduling/reminders");
    const { setBoolSetting } = await import("../lib/settings");
    const tpl = await prisma.appointmentMessageTemplate.findUniqueOrThrow({ where: { key: "reminder_24h" } });
    const conf = await prisma.appointmentMessageTemplate.findUniqueOrThrow({ where: { key: "confirmation" } });
    const remType = await prisma.appointmentType.create({
      data: {
        name: `${tag} reminded consult`,
        durationMin: 30,
        selfServiceCutoffHours: 72,
        requirements: { create: [{ kind: "doctor" }, { kind: "room", subtype: "consult2" }] },
        reminderRules: {
          create: [
            { kind: "on_booking", templateId: conf.id, channels: ["whatsapp"] },
            { kind: "before", minutesBefore: 60, templateId: tpl.id, channels: ["whatsapp"] },
          ],
        },
      },
    });
    extraTypes.push(remType.id);
    const drR = await prisma.resource.create({ data: { kind: "doctor", name: `${tag} reminder doctor` } });
    extraResources.push(drR.id);
    const rb = { leadId: lead.id, branchId: branch.id, typeId: remType.id, resourceIds: [drR.id], acknowledgeWarnings: true };
    const first = await bookAppointment({ ...rb, startAt: at(12 * 60) }, actor);
    const firstId = first.ok ? first.appointmentId : "";

    await check("booking creates the type's reminders (confirmation now, 1 h before)", async () => {
      assert.ok(first.ok);
      const rows = await prisma.appointmentReminder.findMany({ where: { appointmentId: firstId }, orderBy: { dueAt: "asc" } });
      assert.equal(rows.length, 2);
      assert.equal(rows[1].dueAt.getTime(), at(11 * 60).getTime());
    });

    let movedRemId = "";
    await check("rescheduling cancels the old reminders and makes new ones (no second confirmation)", async () => {
      const r = await rescheduleAppointment(firstId, { startAt: at(13 * 60) }, actor);
      assert.ok(r.ok, !r.ok ? r.error : "");
      movedRemId = r.ok ? r.appointmentId : "";
      const old = await prisma.appointmentReminder.findMany({ where: { appointmentId: firstId } });
      assert.ok(old.filter((x) => x.status === "pending").length === 0);
      const fresh = await prisma.appointmentReminder.findMany({ where: { appointmentId: movedRemId } });
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].templateId, tpl.id);
    });

    await check("while reminders are switched off, due ones are skipped — never saved up", async () => {
      await setBoolSetting("scheduling.remindersEnabled", false);
      await prisma.appointmentReminder.updateMany({ where: { appointmentId: movedRemId }, data: { dueAt: new Date(Date.now() - 1000) } });
      await reminders.processDueReminders();
      const r = await prisma.appointmentReminder.findFirstOrThrow({ where: { appointmentId: movedRemId } });
      assert.equal(r.status, "skipped");
      assert.match(r.lastError ?? "", /switched off/);
    });

    await check("switched on, an unconfigured channel is skipped and said so (never silent)", async () => {
      await setBoolSetting("scheduling.remindersEnabled", true);
      await prisma.appointmentReminder.updateMany({ where: { appointmentId: movedRemId }, data: { status: "pending" } });
      await reminders.processDueReminders();
      const r = await prisma.appointmentReminder.findFirstOrThrow({ where: { appointmentId: movedRemId } });
      assert.equal(r.status, "skipped");
      assert.match(r.whatsapp ?? "", /not configured/);
      await setBoolSetting("scheduling.remindersEnabled", false);
    });

    await check("a reply of 1 confirms the appointment", async () => {
      await prisma.appointmentReminder.updateMany({ where: { appointmentId: movedRemId }, data: { status: "sent", sentAt: new Date() } });
      const handled = await reminders.handleAppointmentReply(lead.id, "1");
      assert.equal(handled, true);
      const a = await prisma.appointment.findUniqueOrThrow({ where: { id: movedRemId } });
      assert.equal(a.status, "confirmed");
    });

    await check("a reply of 2 inside the 72 h cut-off opens a call-required case", async () => {
      const handled = await reminders.handleAppointmentReply(lead.id, "2");
      assert.equal(handled, true);
      const c = await prisma.rebookingCase.findFirstOrThrow({ where: { appointmentId: movedRemId, cause: "patient_request" } });
      assert.equal(c.urgent, true);
    });

    await check("cancelling the appointment cancels its pending reminders", async () => {
      const x = await bookAppointment({ ...rb, startAt: at(15 * 60) }, actor);
      assert.ok(x.ok);
      const id = x.ok ? x.appointmentId : "";
      await changeAppointmentStatus(id, "cancelled", { reason: "test", cancelledBy: "patient" }, actor);
      const pending = await prisma.appointmentReminder.count({ where: { appointmentId: id, status: "pending" } });
      assert.equal(pending, 0);
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
    await prisma.branch.deleteMany({ where: { id: { in: [branch.id, ...extraBranches] } } });
    await prisma.$disconnect();
  }
}

(async () => {
  await engineChecks();
  await spec21Checks();
  await spec22Checks();
  await spec29Checks();
  await spec24Checks();
  if (process.env.CHECK_DB !== "0") await dbChecks();
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
  // The messaging modules (WhatsApp/Redis) keep sockets open; exit explicitly so the
  // check finishes in CI and in a terminal alike.
  process.exit(process.exitCode ?? 0);
})();
