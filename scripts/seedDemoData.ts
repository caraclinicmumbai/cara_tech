// Demo data for looking at the CRM with something in it (§dashboard).
//
//   npm run seed:demo           seed (replaces any previous demo data)
//   npm run seed:demo -- --clear   remove it and leave nothing behind
//
// **Every row it creates is tagged `externalId = "demo:…"`**, which is how
// clearing can be exact: it deletes what this script made and cannot touch a
// real lead, whatever else is in the database. Calls cascade with their lead.
//
// It writes through Prisma directly rather than through `ingestLead`, which
// means none of the automation fires — no AI calls placed, no WhatsApp sent, no
// campaign enrolments, no Slack. Seeding a few hundred leads through the real
// intake path would try to ring several hundred people.
//
// **Local only.** It refuses to run against a non-local DATABASE_URL unless
// forced, because "I seeded the demo data into production" is a mistake with no
// undo worth having.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MARKER = "demo:";
const DAYS = 45;
const DAY_MS = 86_400_000;

/// Deterministic PRNG (mulberry32) so a re-seed reproduces the same shape —
/// a dashboard that reshuffles every run is hard to talk about.
function rng(seed: number) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260914);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = [
  "Aarav", "Vivaan", "Aditya", "Arjun", "Reyansh", "Krishna", "Ishaan", "Rohan", "Kabir", "Aryan",
  "Ananya", "Diya", "Saanvi", "Aadhya", "Priya", "Neha", "Kavya", "Isha", "Meera", "Riya",
  "Rahul", "Siddharth", "Karan", "Nikhil", "Varun", "Sneha", "Pooja", "Anjali", "Divya", "Shreya",
];
const LAST = [
  "Sharma", "Verma", "Patel", "Iyer", "Nair", "Reddy", "Kulkarni", "Joshi", "Mehta", "Shah",
  "Desai", "Kapoor", "Malhotra", "Chopra", "Bhat", "Rao", "Gupta", "Singh", "Pillai", "Menon",
];

/// Weighted so the mix looks like a clinic's actual intake rather than an even
/// split — paid social dominates, walk-ins are rare.
const SOURCES: [string, number][] = [
  ["facebook", 28],
  ["web_form", 22],
  ["instagram", 16],
  ["google", 13],
  ["referral", 10],
  ["manual", 7],
  ["walk_in", 4],
];

const INTERESTS = [
  "Hair transplant", "PRP therapy", "Hair loss consultation", "Beard transplant",
  "Skin — acne scars", "Laser hair removal", "Anti-ageing", "Hydrafacial",
];

const CAMPAIGNS = [
  "FB — Hair Transplant Mumbai", "IG — PRP Reels", "Google — Hair Clinic Andheri",
  "FB — Monsoon Offer", null,
];

const LOST_TAGS = ["pricing issue", "went elsewhere", "not the right time", "no response"];

function weightedSource(): string {
  const total = SOURCES.reduce((n, [, w]) => n + w, 0);
  let roll = rand() * total;
  for (const [name, w] of SOURCES) {
    roll -= w;
    if (roll <= 0) return name;
  }
  return "manual";
}

/// Leads per day. Sundays are quiet, and there is a slow upward drift so the
/// month-on-month deltas on the dashboard have something real to report.
function volumeFor(daysAgo: number, date: Date): number {
  const sunday = date.getUTCDay() === 0;
  const drift = 1 + (DAYS - daysAgo) / DAYS / 2; // ~1.0 → ~1.5 over the window
  const base = sunday ? between(1, 4) : between(5, 13);
  return Math.max(1, Math.round(base * drift));
}

async function clear(): Promise<number> {
  // Calls, quotes and the rest cascade from the lead.
  const { count } = await prisma.lead.deleteMany({ where: { externalId: { startsWith: MARKER } } });
  return count;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const local = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);
  const forced = process.argv.includes("--force");
  if (!local && !forced) {
    console.error(
      `❌ DATABASE_URL does not look local (${new URL(url || "postgres://x/y").host}).\n` +
        `   Demo data belongs in a development database. Re-run with --force if you are certain.`,
    );
    process.exit(1);
  }

  const removed = await clear();
  if (process.argv.includes("--clear")) {
    console.log(`✅ Removed ${removed} demo leads (and everything cascading from them).`);
    return;
  }
  if (removed) console.log(`Replaced ${removed} rows from a previous seed.`);

  // Spread ownership over whoever actually exists, so "my leads" and the
  // handover alerts have someone to point at. No reps is fine — leads just
  // stay unassigned, which is a real state too.
  const reps = await prisma.salesRep.findMany({ where: { active: true }, select: { id: true } });

  const now = Date.now();
  let made = 0;
  let calls = 0;

  for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
    const dayStart = new Date(now - daysAgo * DAY_MS);
    const count = volumeFor(daysAgo, dayStart);

    for (let i = 0; i < count; i++) {
      // Business hours-ish, so the Created column doesn't read 3 a.m.
      const createdAt = new Date(
        dayStart.getTime() - dayStart.getUTCHours() * 3_600_000 + (between(9, 20) * 3_600_000) + between(0, 59) * 60_000,
      );
      if (createdAt.getTime() > now) continue;

      const first = pick(FIRST);
      const source = weightedSource();
      const rep = reps.length && chance(0.85) ? pick(reps) : null;
      const social = source === "facebook" || source === "instagram";

      // How far this lead got. Most are called; a good number never were,
      // which is the queue the dashboard's first card counts.
      const called = chance(0.62);
      const outcome = called
        ? pick(["confirmed", "confirmed", "rescheduled", "rescheduled", "no_answer", "no_answer", "no_answer", "not_interested"] as const)
        : null;

      let status = "new";
      let stage = "ai_contacted";
      let lostAt: Date | null = null;
      let lostTag: string | null = null;
      let optedOut = false;

      if (outcome === "confirmed") {
        status = "confirmed";
        stage = "appointment_scheduled";
      } else if (outcome === "rescheduled") {
        status = "rescheduled";
        stage = "in_consideration";
      } else if (outcome === "no_answer") {
        status = chance(0.4) ? "unreachable" : "called";
        stage = "communication_not_established";
      } else if (outcome === "not_interested") {
        status = "not_interested";
        stage = "lost";
        optedOut = chance(0.6);
        lostAt = new Date(createdAt.getTime() + between(1, 5) * DAY_MS);
        lostTag = pick(LOST_TAGS);
        if (lostAt.getTime() > now) lostAt = new Date(now - DAY_MS);
      }

      // A consultation happened for some of the confirmed ones.
      if (status === "confirmed" && chance(0.35)) stage = "consultation_done";
      if (status === "confirmed" && chance(0.12)) stage = "converted";

      const needsHandover = called && outcome !== "confirmed" && chance(0.07);
      const callAt = called
        ? new Date(Math.min(createdAt.getTime() + between(5, 240) * 60_000, now))
        : null;

      const lead = await prisma.lead.create({
        data: {
          externalId: `${MARKER}${daysAgo}-${i}`,
          name: `${first} ${pick(LAST)}`,
          phone: `+9198${String(between(10000000, 99999999))}`,
          email: chance(0.45) ? `${first.toLowerCase()}${between(1, 99)}@example.com` : null,
          interest: pick(INTERESTS),
          source,
          campaign: social ? pick(CAMPAIGNS) : null,
          status,
          stage,
          stageChangedAt: callAt ?? createdAt,
          interestLevel: outcome === "confirmed" ? "high" : outcome === "rescheduled" ? "medium" : null,
          tag: called && chance(0.5) ? pick(INTERESTS) : null,
          assignedRepId: rep?.id ?? null,
          assignedAt: rep ? createdAt : null,
          optedOut,
          optedOutAt: optedOut ? lostAt : null,
          optedOutReason: optedOut ? "not_interested on call" : null,
          needsHandover,
          handoverReason: needsHandover ? pick(["price_request", "wants_human", "clinical_question"]) : null,
          handoverAt: needsHandover ? callAt : null,
          handoverTriggers: needsHandover ? ["wants_human"] : [],
          lostAt,
          lostTag,
          prematureLost: lostAt !== null && stage === "lost" && chance(0.3),
          createdAt,
          updatedAt: callAt ?? createdAt,
        },
        select: { id: true },
      });
      made++;

      if (called && callAt) {
        await prisma.call.create({
          data: {
            leadId: lead.id,
            callType: "initial",
            outcome,
            sentiment:
              outcome === "confirmed"
                ? "positive"
                : outcome === "not_interested"
                  ? "negative"
                  : pick(["neutral", "positive", "neutral"] as const),
            // An unanswered call is a few seconds of ringing, not a conversation.
            duration: outcome === "no_answer" ? between(3, 18) : between(45, 320),
            cqs: outcome === "no_answer" ? null : between(28, 96),
            createdAt: callAt,
          },
        });
        calls++;

        // A second attempt for some of the ones nobody reached.
        if (outcome === "no_answer" && chance(0.45)) {
          const retryAt = new Date(Math.min(callAt.getTime() + DAY_MS, now));
          await prisma.call.create({
            data: {
              leadId: lead.id,
              callType: "reconfirmation",
              outcome: pick(["no_answer", "no_answer", "confirmed", "rescheduled"] as const),
              sentiment: pick(["neutral", "positive"] as const),
              duration: between(4, 210),
              createdAt: retryAt,
            },
          });
          calls++;
        }
      }
    }
  }

  console.log(
    `✅ Seeded ${made} leads and ${calls} calls across the last ${DAYS} days.\n` +
      `   Remove them at any time with:  npm run seed:demo -- --clear`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
