// Self-check for the telecalling reports (§reports 12–15) and their Slack delivery. Seeds a
// known week in March 2020, far from real data, checks every figure, and removes what it made.
// Refuses to run against anything but a local database. Slack is captured, never contacted.
//
//   ./node_modules/.bin/dotenv -e .env.local -- ./node_modules/.bin/tsx scripts/checkTelecallingReports.ts
import assert from "node:assert/strict";
import axios from "axios";
import { prisma } from "@/lib/prisma";
import { recordActivitySession } from "@/lib/presence";
import { resolveRange } from "@/lib/reports/range";
import { bucketStart, telecallingReport } from "@/lib/reports/telecalling";
import { scoreSpeed, speedToCall } from "@/lib/reports/speedToCall";
import { activityForDay, telecallerActivity } from "@/lib/reports/telecallerActivity";
import { followUpTracking } from "@/lib/reports/followUpTracking";
import { buildAnalysis, reportRanges, sendTelecallingReport } from "@/lib/reports/telecallingSlack";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("Refusing to run: DATABASE_URL isn't a local database.");
  process.exit(1);
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

/// An IST wall-clock moment as an instant.
const ist = (day: string, time: string) => new Date(`${day}T${time}:00+05:30`);
const D = "2020-03-10"; // a Tuesday

function pure() {
  console.log("Speed to call scoring");
  const later = ist(D, "18:00");
  check("called inside 5 minutes is within", () => {
    const s = scoreSpeed(ist(D, "12:00"), ist(D, "12:04"), later);
    assert.equal(s.result, "within");
    assert.equal(s.tatMs, 4 * 60_000);
  });
  check("exactly 5 minutes is within, a moment more is late", () => {
    assert.equal(scoreSpeed(ist(D, "12:00"), ist(D, "12:05"), later).result, "within");
    assert.equal(scoreSpeed(ist(D, "12:00"), new Date(ist(D, "12:05").getTime() + 1000), later).result, "late");
  });
  check("overnight lead's clock starts at the 10:00 opening", () => {
    const s = scoreSpeed(ist(D, "03:00"), ist(D, "10:03"), later);
    assert.equal(s.result, "within");
    assert.equal(s.tatMs, 3 * 60_000);
    assert.equal(s.clockStart.getTime(), ist(D, "10:00").getTime());
  });
  check("late-night lead's clock starts the next morning", () => {
    assert.equal(scoreSpeed(ist(D, "23:00"), null, later).clockStart.getTime(), ist("2020-03-11", "10:00").getTime());
  });
  check("a call before the window opens is a wait of zero, not negative", () => {
    const s = scoreSpeed(ist(D, "03:00"), ist(D, "09:00"), later);
    assert.equal(s.tatMs, 0);
    assert.equal(s.result, "within");
  });
  check("uncalled is waiting for 5 minutes, then not called", () => {
    assert.equal(scoreSpeed(ist(D, "12:00"), null, ist(D, "12:03")).result, "waiting");
    assert.equal(scoreSpeed(ist(D, "12:00"), null, ist(D, "12:06")).result, "not_called");
  });
  check("a call after the reporting moment hasn't happened yet", () => {
    assert.equal(scoreSpeed(ist(D, "12:00"), ist(D, "12:02"), ist(D, "12:01")).result, "waiting");
  });

  console.log("Activity arithmetic");
  const iv = (a: string, b: string) => ({ start: ist(D, a).getTime(), end: ist(D, b).getTime() });
  const far = ist("2020-03-20", "12:00").getTime();
  const min = (ms: number) => ms / 60_000;
  check("a gap of 5+ minutes is an inactive period, shown exactly", () => {
    const d = activityForDay(D, { sessions: [iv("11:00", "12:00"), iv("12:30", "13:00")], calls: [], breaks: [] }, far);
    assert.equal(min(d.activeMs), 90);
    assert.equal(min(d.inactiveMs), 30);
    assert.deepEqual(d.periods.map((p) => [p.start, p.end, p.kind]), [
      [ist(D, "12:00").getTime(), ist(D, "12:30").getTime(), "inactive"],
    ]);
  });
  check("a gap under 5 minutes is ignored", () => {
    const d = activityForDay(D, { sessions: [iv("11:00", "12:00"), iv("12:04", "13:00")], calls: [], breaks: [] }, far);
    assert.equal(d.periods.length, 0);
    assert.equal(min(d.activeMs), 120);
  });
  check("a call with the CRM closed counts as active", () => {
    const d = activityForDay(D, { sessions: [iv("11:00", "12:00"), iv("13:00", "14:00")], calls: [iv("12:00", "13:00")], breaks: [] }, far);
    assert.equal(d.periods.length, 0);
    assert.equal(min(d.activeMs), 180);
  });
  check("a Break isn't active even with the tab open, and is labelled", () => {
    const d = activityForDay(D, { sessions: [iv("11:00", "14:00")], calls: [], breaks: [iv("12:00", "13:00")] }, far);
    assert.equal(min(d.activeMs), 120);
    assert.equal(d.periods[0].kind, "break");
  });
  check("a call during a Break still counts", () => {
    const d = activityForDay(D, { sessions: [iv("11:00", "14:00")], calls: [iv("12:20", "12:40")], breaks: [iv("12:00", "13:00")] }, far);
    assert.equal(min(d.activeMs), 140);
    assert.equal(d.periods.length, 2);
  });
  check("a tab left open overnight is clipped to the calling window", () => {
    const d = activityForDay(D, { sessions: [{ start: ist("2020-03-09", "23:00").getTime(), end: ist("2020-03-11", "02:00").getTime() }], calls: [], breaks: [] }, far);
    assert.equal(d.first, ist(D, "10:00").getTime());
    assert.equal(d.last, ist(D, "22:00").getTime());
  });
  check("a day with nothing in it reports no activity, not zero ratio", () => {
    const d = activityForDay(D, { sessions: [], calls: [], breaks: [] }, far);
    assert.equal(d.first, null);
  });

  console.log("Periods");
  check("weeks start on Monday, months on the 1st", () => {
    assert.equal(bucketStart("2020-03-10", "week"), "2020-03-09");
    assert.equal(bucketStart("2020-03-09", "week"), "2020-03-09");
    assert.equal(bucketStart("2020-03-15", "week"), "2020-03-09"); // Sunday
    assert.equal(bucketStart("2020-03-10", "month"), "2020-03-01");
  });
  check("daily compares with yesterday up to the same time", () => {
    const now = ist(D, "20:00");
    const { current, previous } = reportRanges("daily", now);
    assert.equal(current.start.getTime(), ist(D, "00:00").getTime());
    assert.equal(current.end.getTime(), now.getTime());
    assert.equal(previous.start.getTime(), ist("2020-03-09", "00:00").getTime());
    assert.equal(previous.end.getTime(), ist("2020-03-09", "20:00").getTime());
  });
  check("weekly on a Monday covers last Monday to Sunday", () => {
    const { current, previous } = reportRanges("weekly", ist("2020-03-16", "09:00"));
    assert.deepEqual([current.fromDay, current.toDay], ["2020-03-09", "2020-03-15"]);
    assert.deepEqual([previous.fromDay, previous.toDay], ["2020-03-02", "2020-03-08"]);
  });
  check("monthly covers whole calendar months, including a leap February", () => {
    const { current, previous } = reportRanges("monthly", ist("2020-04-01", "09:00"));
    assert.deepEqual([current.fromDay, current.toDay], ["2020-03-01", "2020-03-31"]);
    assert.deepEqual([previous.fromDay, previous.toDay], ["2020-02-01", "2020-02-29"]);
  });
}

const TAG = "check-telecalling";

async function cleanup() {
  const reps = await prisma.salesRep.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const repIds = reps.map((r) => r.id);
  await prisma.appointment.deleteMany({ where: { lead: { name: { startsWith: TAG } } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } }); // cascades calls and steps
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  await prisma.salesRep.deleteMany({ where: { id: { in: repIds } } }); // cascades sessions
}

async function seeded() {
  await cleanup();
  const a = await prisma.salesRep.create({ data: { name: `${TAG} Asha`, phone: "+910000000001", slackUserId: "U0CHECK01" } });
  const b = await prisma.salesRep.create({ data: { name: `${TAG} Bina`, phone: "+910000000002", slackUserId: "not-a-slack-id" } });
  const user = await prisma.user.create({
    data: { email: `${TAG}@example.test`, passwordHash: "x", role: "telecaller", salesRepId: a.id },
  });
  const frontDesk = await prisma.user.create({
    data: { email: `${TAG}-desk@example.test`, passwordHash: "x", role: "front_desk" },
  });

  const lead = (suffix: string, at: Date, extra: Record<string, unknown> = {}) =>
    prisma.lead.create({
      data: {
        name: `${TAG} ${suffix}`,
        phone: `+9199${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        source: "facebook",
        createdAt: at,
        assignedRepId: a.id,
        ...extra,
      },
    });
  const call = (leadId: string, at: Date, extra: Record<string, unknown>) =>
    prisma.call.create({ data: { leadId, callType: "human_handover", createdAt: at, handledById: a.id, ...extra } });

  // Speed: within, late, never called, plus everything that must be left out.
  const quick = await lead("quick", ist(D, "12:00"));
  await call(quick.id, ist(D, "12:02"), { outcome: "connected", duration: 120 });
  const slow = await lead("slow", ist(D, "13:00"));
  await call(slow.id, ist(D, "13:20"), { outcome: "no_answer", handledById: b.id });
  const never = await lead("never", ist(D, "14:00"));
  // An AI call doesn't stop the clock on it.
  await prisma.call.create({ data: { leadId: never.id, callType: "initial", createdAt: ist(D, "14:01"), outcome: "confirmed", duration: 60 } });
  const noSource = await lead("nosource", ist(D, "15:00"), { source: null });
  await call(noSource.id, ist(D, "15:01"), { outcome: null, duration: 240 });
  await lead("inbound", ist(D, "12:30"), { source: "inbound_call" });
  await lead("walkin", ist(D, "12:30"), { source: "walk_in" });
  await lead("legacy", ist(D, "12:30"), { externalId: `legacy:${TAG}` });
  await lead("dupe", ist(D, "12:30"), { duplicateOfId: quick.id });

  // Clinic line: one answered, one missed (nobody's), one voicemail (nobody's).
  await prisma.call.create({ data: { leadId: quick.id, callType: "inbound", createdAt: ist(D, "16:00"), outcome: "connected", duration: 60, handledById: a.id } });
  await prisma.call.create({ data: { leadId: quick.id, callType: "inbound", createdAt: ist(D, "16:10"), outcome: "missed" } });
  await prisma.call.create({ data: { leadId: quick.id, callType: "inbound_voicemail", createdAt: ist(D, "16:20"), outcome: "voicemail", duration: 30 } });
  // Outside the range.
  await call(quick.id, ist("2020-03-20", "12:00"), { outcome: "connected", duration: 999 });
  // Previous day, for the comparison.
  await call(quick.id, ist("2020-03-09", "12:00"), { outcome: "connected", duration: 60 });

  // Appointments.
  const branch = await prisma.branch.findFirst({ select: { id: true } });
  const type = await prisma.appointmentType.findFirst({ select: { id: true } });
  assert.ok(branch && type, "local DB needs a branch and an appointment type");
  const appt = (status: string, createdAt: Date, startAt: Date, bookedById: string, extra: Record<string, unknown> = {}) =>
    prisma.appointment.create({
      data: { leadId: quick.id, branchId: branch.id, typeId: type.id, status, createdAt, startAt, endAt: new Date(startAt.getTime() + 30 * 60_000), bookedById, ...extra },
    });
  const came = await appt("completed", ist(D, "12:05"), ist(D, "17:00"), user.id);
  await appt("no_show", ist(D, "12:06"), ist("2020-03-11", "17:00"), user.id);
  await appt("booked", ist(D, "12:07"), ist("2020-03-12", "17:00"), user.id, { rescheduledFromId: came.id });
  await appt("tentative", ist(D, "12:08"), ist("2020-03-12", "18:00"), user.id);
  await appt("completed", ist(D, "12:09"), ist(D, "18:00"), frontDesk.id); // not a telecaller's

  // Follow-ups, as at 16:00 on D.
  const now = ist(D, "16:00");
  const step = (leadId: string, dueAt: Date, extra: Record<string, unknown> = {}) =>
    prisma.leadFollowUpStep.create({ data: { leadId, order: 0, title: `${TAG} step`, dueAt, ownerRepId: a.id, ...extra } });
  await step(quick.id, ist(D, "11:00")); // missed today
  await step(quick.id, ist(D, "17:00")); // a second one on the same lead: still one lead
  await step(never.id, ist(D, "17:30")); // due later today
  await step(slow.id, ist("2020-03-05", "11:00")); // overdue
  await step(slow.id, ist(D, "10:00"), { status: "done" }); // done
  await step(slow.id, ist("2020-03-05", "12:00"), { ownerKind: "ai", ownerRepId: null }); // AI's
  const legacy = await prisma.lead.findFirstOrThrow({ where: { name: `${TAG} legacy` } });
  await step(legacy.id, ist("2020-03-01", "11:00")); // carried over
  const lost = await lead("lost", ist("2020-01-01", "12:00"), { source: "walk_in", stage: "lost" });
  await step(lost.id, ist("2020-03-04", "11:00")); // on a lost lead: not counted

  // Activity for rep A: 11:00–12:00 and 13:00–14:00, then a call while the tab was closed.
  await prisma.repActivitySession.createMany({
    data: [
      { repId: a.id, startedAt: ist(D, "11:00"), lastSeenAt: ist(D, "12:00") },
      { repId: a.id, startedAt: ist(D, "13:00"), lastSeenAt: ist(D, "14:00") },
    ],
  });

  const range = resolveRange({ from: D, to: D });

  console.log("Telecalling");
  const t = await telecallingReport(range);
  const rowA = t.reps.find((r) => r.repId === a.id)!;
  const rowB = t.reps.find((r) => r.repId === b.id)!;
  check("counts person-handled calls only, with the AI call and missed calls left out", () => {
    assert.equal(rowA.calls, 3);
    assert.equal(rowB.calls, 1);
    assert.equal(rowA.outbound, 2);
    assert.equal(rowA.inbound, 1);
  });
  check("connected follows the Calls page rule, including a NULL outcome with a duration", () => {
    assert.equal(rowA.connected, 3);
    assert.equal(rowB.connected, 0);
    assert.equal(rowB.notConnected, 1);
    assert.equal(rowB.connectPct, 0);
  });
  check("talk time and the average", () => {
    assert.equal(rowA.talkSeconds, 120 + 240 + 60);
    assert.equal(rowA.avgSeconds, (120 + 240 + 60) / 3);
    assert.equal(rowB.avgSeconds, null); // nothing to divide by isn't zero
  });
  check("appointments: reschedules, holds and the front desk's bookings don't count", () => {
    assert.equal(rowA.booked, 2);
    assert.equal(rowA.showed, 1);
    assert.equal(rowA.noShows, 0); // dated the 11th, outside this one-day range
    assert.equal(rowA.showPct, 100);
  });
  check("missed clinic-line calls are counted beside the table", () => {
    assert.equal(t.missedInbound, 2);
  });
  check("a one-day range is one row", () => {
    assert.equal(t.buckets.length, 1);
  });
  const mine = await telecallingReport(range, "day", b.id);
  check("a one-person report excludes colleagues", () => {
    assert.equal(mine.totals.calls, 1);
    assert.equal(mine.totals.booked, 0);
    assert.equal(mine.missedInbound, null);
  });
  const weekRange = resolveRange({ from: "2020-03-04", to: "2020-03-20" });
  const weekly = await telecallingReport(weekRange, "week");
  check("weekly buckets stay inside the range and keep empty weeks", () => {
    assert.deepEqual(weekly.buckets.map((x) => x.fromDay), ["2020-03-04", "2020-03-09", "2020-03-16"]);
    assert.equal(weekly.buckets[1].calls, 5); // 4 on D + 1 on the 9th
    assert.equal(weekly.buckets[0].calls, 0);
    assert.equal(weekly.buckets[1].noShows, 1);
  });

  console.log("Speed to Call");
  const s = await speedToCall(range, { asOf: ist("2020-03-25", "12:00") });
  const byName = new Map(s.records.map((r) => [r.leadName.replace(`${TAG} `, ""), r]));
  check("inbound callers, walk-ins, legacy and merged leads are left out; no source is kept", () => {
    assert.deepEqual([...byName.keys()].sort(), ["never", "nosource", "quick", "slow"]);
  });
  check("each lead scores correctly, and an AI call doesn't stop the clock", () => {
    assert.equal(byName.get("quick")!.result, "within");
    assert.equal(byName.get("slow")!.result, "late");
    assert.equal(byName.get("never")!.result, "not_called");
    assert.equal(byName.get("nosource")!.result, "within");
  });
  check("a call from before the lead arrived isn't its first call", () => {
    assert.equal(byName.get("quick")!.tatMs, 2 * 60_000);
  });
  check("credit goes to the first caller, or the owner if none", () => {
    assert.equal(byName.get("slow")!.repId, b.id);
    assert.equal(byName.get("never")!.repId, a.id);
    assert.equal(byName.get("slow")!.connected, false);
  });
  check("rate over settled leads", () => {
    assert.equal(s.totals.within, 2);
    assert.equal(s.totals.withinPct, 50);
  });
  const asOfEarly = await speedToCall(range, { asOf: ist(D, "12:01") });
  check("as of an earlier moment, later leads and calls are ignored properly", () => {
    assert.equal(asOfEarly.records.find((r) => r.leadName.endsWith("quick"))!.result, "waiting");
  });
  const speedB = await speedToCall(range, { repId: b.id, asOf: ist("2020-03-25", "12:00") });
  check("one person's view holds only their leads", () => {
    assert.deepEqual(speedB.records.map((r) => r.leadName), [`${TAG} slow`]);
  });

  console.log("Telecaller Activity");
  const activity = await telecallerActivity(range, { now: ist("2020-03-25", "12:00") });
  const actA = activity.reps.find((r) => r.repId === a.id)!;
  check("sessions and calls merge into the day", () => {
    assert.equal(actA.daysActive, 1);
    assert.equal(actA.days[0].first, ist(D, "11:00").getTime());
    assert.equal(actA.days[0].periods.length >= 1, true);
  });
  check("the ratio adds up", () => {
    assert.equal(actA.activePct, (actA.activeMs / (actA.activeMs + actA.inactiveMs)) * 100);
  });

  console.log("Heartbeat");
  const tick = ist("2020-03-12", "11:00");
  await recordActivitySession(b.id, tick);
  await recordActivitySession(b.id, new Date(tick.getTime() + 90_000));
  await recordActivitySession(b.id, new Date(tick.getTime() + 60 * 60_000));
  const sessions = await prisma.repActivitySession.findMany({ where: { repId: b.id }, orderBy: { startedAt: "asc" } });
  check("beats 90s apart extend a session; an hour's gap starts another", () => {
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].lastSeenAt.getTime(), tick.getTime() + 90_000);
  });

  console.log("Follow-Ups");
  const f = await followUpTracking({ now });
  const fA = f.reps.find((r) => r.repId === a.id)!;
  check("leads are counted once each: missed today, overdue, due later today and carried over told apart", () => {
    assert.equal(fA.missedToday, 1);
    assert.equal(fA.overdue, 1);
    assert.equal(fA.dueLaterToday, 1);
    assert.equal(fA.carriedOver, 1);
  });
  const asha = f.leads.filter((x) => x.repId === a.id);
  check("one row per lead, in working order; done, AI and lost-lead follow-ups don't count", () => {
    assert.deepEqual(
      asha.map((x) => [x.leadId, x.status]),
      [[quick.id, "missed_today"], [slow.id, "overdue"], [never.id, "due_later_today"]],
    );
  });
  check("a lead's other follow-ups and last call ride along", () => {
    const q = asha.find((x) => x.leadId === quick.id)!;
    assert.deepEqual(q.others.map((o) => o.dueAt.getTime()), [ist(D, "17:00").getTime()]);
    assert.ok(q.lastCall);
  });

  console.log("Slack");
  const analysisNumbers = {
    calls: t,
    speed: await speedToCall(range, { asOf: ist("2020-03-25", "12:00") }),
    activity,
    followUps: f,
  };
  const prevRange = resolveRange({ from: "2020-03-09", to: "2020-03-09" });
  const prev = { calls: await telecallingReport(prevRange), speed: await speedToCall(prevRange, { asOf: now }) };
  const lines = buildAnalysis(analysisNumbers, prev, "daily");
  check("the analysis states real figures, at most four lines", () => {
    assert.ok(lines.length >= 1 && lines.length <= 4);
    assert.match(lines.join(" "), /Calls up 300% .*\(4 vs 1\)/);
    assert.match(lines.join(" "), /50% of new leads were called within 5 minutes/);
  });
  check("an empty period says so rather than inventing a trend", () => {
    const empty = { ...analysisNumbers, calls: { ...t, totals: { ...t.totals, calls: 0 } }, speed: { ...s, totals: { ...s.totals, leads: 0 } } };
    assert.deepEqual(buildAnalysis(empty, null, "weekly"), ["No telecalling activity was recorded in this period."]);
  });

  const sent: { channel: string; text: string; blocks?: unknown[] }[] = [];
  axios.defaults.adapter = async (config) => {
    sent.push(JSON.parse(config.data as string));
    return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
  };
  process.env.SLACK_BOT_TOKEN = "check";
  process.env.SLACK_DEFAULT_CHANNEL = "C0SHARED";
  process.env.TELECALLING_REPORT_CHANNEL = "C0REPORT";
  const ok = await sendTelecallingReport("daily", ist(D, "20:00"));
  check("the team summary reaches the report channel with no patient names in it", () => {
    assert.equal(ok, true);
    const team = sent.find((m) => m.channel === "C0REPORT")!;
    assert.ok(team);
    const body = JSON.stringify(team);
    assert.match(body, /Daily telecalling report/);
    assert.match(body, /Analysis/);
    for (const name of ["quick", "slow", "never", "nosource"]) assert.ok(!body.includes(`${TAG} ${name}`), name);
  });
  check("a DM goes to a real member id, and a bad id doesn't spill into the shared channel", () => {
    const dm = sent.find((m) => m.channel === "U0CHECK01")!;
    assert.ok(dm);
    assert.match(dm.text, /Your daily numbers/);
    assert.equal(sent.filter((m) => m.channel === "C0SHARED").length, 0);
    assert.equal(sent.filter((m) => m.channel === "not-a-slack-id").length, 0);
  });
}

async function main() {
  pure();
  try {
    await seeded();
  } finally {
    await cleanup();
  }
  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
