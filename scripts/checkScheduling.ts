// Self-check for the scheduling engine (§3.2). Two parts:
//
//   1. ENGINE — the pure rules, no database: rooms never double, doctors double only
//      with an acknowledged warning (and only when allowed), branch hours / closures,
//      rosters, leave, support-staff requirements, auto-fill, slot finding.
//   2. DATABASE — the guarantee under concurrency: fire many simultaneous bookings at
//      one room and confirm exactly one wins; reschedule frees the old slot; status
//      changes release resources. Creates its own fixtures and deletes them after.
//
// Usage: npm run check:scheduling            (both parts)
//        CHECK_DB=0 npm run check:scheduling (engine only)
import assert from "node:assert/strict";
import {
  evaluateSlot,
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
};

function res(p: Partial<EngineResource> & Pick<EngineResource, "id" | "kind">): EngineResource {
  return {
    subtype: null,
    name: p.id,
    branchId: "B1",
    active: true,
    sortOrder: 0,
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
  res({ id: "room1", kind: "room", subtype: "consultation" }),
  res({ id: "ot1", kind: "room", subtype: "ot" }),
  res({ id: "tech1", kind: "staff", subtype: "technician", branchId: null }),
  res({ id: "tech2", kind: "staff", subtype: "technician", branchId: null }),
  res({ id: "otherRoom", kind: "room", subtype: "consultation", branchId: "B2" }),
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

  await check("free slot books with auto-filled doctor + room", () => {
    const r = evaluateSlot(ctx(), slot(11 * 60, 30));
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
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(11 * 60, 30));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "requirement_unfilled"));
  });

  await check("back-to-back is not a clash (half-open intervals)", () => {
    const r = evaluateSlot(ctx({ busy: [busy("room1", 11 * 60, 12 * 60)] }), slot(12 * 60, 30, { chosenIds: ["room1"] }));
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

  await check("auto-fill never silently picks an overbooked doctor", () => {
    const r = evaluateSlot(ctx({ busy: [busy("drA", 11 * 60, 12 * 60)] }), slot(11 * 60, 30));
    assert.equal(r.ok, true);
    assert.equal(r.needsAck, false);
    assert.ok(r.resourceIds.includes("drB"));
  });

  await check("rescheduling ignores the appointment's own current slot", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("room1", 11 * 60, 12 * 60, "me")] }),
      slot(11 * 60 + 15, 30, { chosenIds: ["room1"], ignoreAppointmentIds: ["me"] }),
    );
    assert.equal(r.ok, true);
  });

  await check("turnover buffer keeps the room blocked after the patient leaves", () => {
    const c = ctx({ busy: [busy("ot1", 11 * 60, 12 * 60 + 30)] }); // 60 min + 30 buffer
    const r = evaluateSlot(c, slot(12 * 60 + 15, 30, { requirements: FUE, chosenIds: ["ot1"] }));
    assert.equal(r.ok, false);
  });

  await check("outside branch hours is blocked", () => {
    const r = evaluateSlot(ctx(), slot(19 * 60 + 45, 30));
    assert.ok(r.issues.some((i) => i.code === "outside_hours" && i.severity === "block"));
  });

  await check("branch hours not enforced → only a warning", () => {
    const r = evaluateSlot(ctx({ toggles: { ...TOGGLES, enforceBranchHours: false } }), slot(19 * 60 + 45, 30));
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
    assert.equal(evaluateSlot(c, slot(14 * 60 + 30, 30)).ok, false);
    assert.equal(evaluateSlot(c, slot(11 * 60, 30)).ok, true);
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
    const r = evaluateSlot(ctx(), slot(10 * 60, 8 * 60, { requirements: FUE }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.resourceIds.sort(), ["drA", "ot1", "tech1", "tech2"]);
  });

  await check("FUE refused when the technician team isn't free", () => {
    const r = evaluateSlot(ctx({ busy: [busy("tech2", 12 * 60, 13 * 60)] }), slot(10 * 60, 8 * 60, { requirements: FUE }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === "requirement_unfilled" && i.message.includes("technician")));
  });

  await check("support-staff scheduling OFF → staff requirement ignored", () => {
    const r = evaluateSlot(
      ctx({ busy: [busy("tech2", 12 * 60, 13 * 60)], toggles: { ...TOGGLES, requireSupportStaff: false } }),
      slot(10 * 60, 8 * 60, { requirements: FUE }),
    );
    assert.equal(r.ok, true);
  });

  await check("a room in another branch can't be used", () => {
    const r = evaluateSlot(ctx(), slot(11 * 60, 30, { chosenIds: ["otherRoom"] }));
    assert.ok(r.issues.some((i) => i.code === "wrong_branch"));
  });

  await check("past start is refused unless back-dating is allowed", () => {
    const later = istInstant(DAY, 12 * 60);
    assert.equal(evaluateSlot(ctx(), slot(11 * 60, 30, { now: later })).ok, false);
    assert.equal(evaluateSlot(ctx(), slot(11 * 60, 30, { now: later, allowPast: true })).ok, true);
  });

  await check("findSlots skips taken times and respects hours", () => {
    const c = ctx({ busy: [busy("room1", 10 * 60, 19 * 60)] });
    const slots = findSlots(c, { durationMin: 30, bufferAfterMin: 0, requirements: CONSULT, chosenIds: [], stepMin: 30, now: NOW, istInstant });
    // room1 is the only consultation room in B1; free 19:00–20:00 → 19:00 and 19:30.
    assert.deepEqual(slots.map((s) => s.startAt.getTime()), [istInstant(DAY, 19 * 60).getTime(), istInstant(DAY, 19 * 60 + 30).getTime()]);
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

  try {
    await check("12 simultaneous bookings of one room → exactly one wins", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => bookAppointment({ ...base, startAt: at(11 * 60), acknowledgeWarnings: true }, actor)),
      );
      const wins = results.filter((r) => r.ok);
      assert.equal(wins.length, 1, `expected 1 winner, got ${wins.length}`);
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

    await check("every write left an audit row", async () => {
      const ids = (await prisma.appointment.findMany({ where: { typeId: type.id }, select: { id: true } })).map((a) => a.id);
      const n = await prisma.auditLog.count({ where: { entityType: "appointment", entityId: { in: ids } } });
      assert.ok(n >= 6, `expected ≥6 audit rows, got ${n}`);
    });
  } finally {
    await prisma.appointment.deleteMany({ where: { typeId: type.id } });
    await prisma.appointmentType.delete({ where: { id: type.id } });
    await prisma.resource.deleteMany({ where: { id: { in: [room.id, doctor.id] } } });
    await prisma.lead.delete({ where: { id: lead.id } });
    await prisma.branch.delete({ where: { id: branch.id } });
    await prisma.$disconnect();
  }
}

(async () => {
  await engineChecks();
  if (process.env.CHECK_DB !== "0") await dbChecks();
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})();
