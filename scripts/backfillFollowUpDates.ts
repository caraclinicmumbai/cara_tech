// Give every lead a next follow-up date (§follow-up).
//
// The Follow up column reads the earliest pending step, so a lead with no steps
// shows nothing — and a lead with no plan is the one that gets forgotten. Leads
// created before the roadmap existed, and the duplicates / held-for-review / walk-in
// leads that intake used to skip, are all in that state.
//
// Seeds the human-only ladder (no AI steps — their calling phase is over or never
// happened), anchored at TODAY rather than the lead's creation date: back-dating
// would paint months of invented "missed" steps instead of a plan someone can work.
//
// Skips leads that are finished — converted or lost — because a next follow-up date
// on a closed lead is noise, not a prompt.
//
// Dry run:  ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/backfillFollowUpDates.ts
// Apply:    ...same... scripts/backfillFollowUpDates.ts --apply
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { seedFollowUpSteps } from "../lib/followups";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const CLOSED_STAGES = ["converted", "lost"];

async function main() {
  const leads = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      stage: { notIn: CLOSED_STAGES },
      followUpSteps: { none: {} },
    },
    select: { id: true, name: true, stage: true, assignedRepId: true, assignedRep: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `${leads.length} active lead(s) with no follow-up dates${APPLY ? "" : "  [dry run — pass --apply]"}`,
  );

  // Anchor at 10:00 IST today so the seeded steps land on tidy working-hour dates
  // rather than inheriting whatever minute this script happened to run at.
  const now = new Date();
  const anchor = new Date(now);
  anchor.setUTCHours(4, 30, 0, 0); // 10:00 IST
  if (anchor < now) anchor.setUTCDate(anchor.getUTCDate() + 1);
  let seeded = 0;
  for (const lead of leads) {
    if (APPLY) {
      const n = await seedFollowUpSteps({
        leadId: lead.id,
        ownerRepId: lead.assignedRepId,
        startAt: anchor,
        aiCalling: false,
      });
      seeded += n > 0 ? 1 : 0;
    }
    console.log(
      `  ${APPLY ? "seeded " : "would seed"}  ${lead.name.padEnd(28)} ${lead.stage.padEnd(24)} → ${lead.assignedRep?.name ?? "unassigned"}`,
    );
  }

  const closed = await prisma.lead.count({
    where: { deletedAt: null, stage: { in: CLOSED_STAGES }, followUpSteps: { none: {} } },
  });
  if (closed > 0) console.log(`\n(${closed} converted/lost lead(s) left alone — no follow-up needed)`);
  if (APPLY) console.log(`\nseeded ${seeded} lead(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
