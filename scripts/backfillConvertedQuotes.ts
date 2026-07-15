// One-time backfill for the multi-quote cutover (Phase 2 §multi-quote).
//
// Before: conversion lived on the lead (`Lead.stage = "converted"`).
// After:  conversion lives on a Quote; the lead's person-track ends at
//         "consultation_done" and each treatment converts on its own.
//
// For every lead still at stage "converted" this creates ONE converted Quote
// (best-effort treatment from the lead's tag/interest) and moves the lead back to
// "consultation_done". Each lead is handled in its own transaction, so a failure
// can't leave a lead half-migrated. Idempotent: it only ever targets leads still
// at "converted", so re-running does nothing once they're all moved.
//
// Usage:
//   DRY_RUN (default true)  — report counts + a sample, write nothing.
//   npx tsx scripts/backfillConvertedQuotes.ts            # dry run
//   BACKFILL_APPLY=1 npx tsx scripts/backfillConvertedQuotes.ts   # live
//
// Env: DATABASE_URL must be loaded (e.g. `set -a; . ./.env.local; set +a`).

import { prisma } from "../lib/prisma";

const APPLY = process.env.BACKFILL_APPLY === "1";
const NEW_LEAD_STAGE = "consultation_done";

function treatmentFor(lead: { tag: string | null; interest: string | null }): string {
  return (lead.tag?.trim() || lead.interest?.trim() || "Treatment (unspecified)").slice(0, 120);
}

async function main() {
  const leads = await prisma.lead.findMany({
    where: { stage: "converted" },
    select: {
      id: true,
      name: true,
      tag: true,
      interest: true,
      assignedRepId: true,
      updatedAt: true,
    },
  });

  console.log(`Leads at stage="converted": ${leads.length}`);
  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  if (leads.length === 0) {
    console.log("Nothing to backfill.");
    await prisma.$disconnect();
    return;
  }

  // Sample of what each becomes.
  console.log("Sample (up to 10):");
  for (const l of leads.slice(0, 10)) {
    console.log(`  ${l.name} → Quote "${treatmentFor(l)}" (converted), lead → ${NEW_LEAD_STAGE}`);
  }
  console.log("");

  if (!APPLY) {
    console.log(`DRY RUN — would create ${leads.length} converted quote(s) and move ${leads.length} lead(s) to "${NEW_LEAD_STAGE}".`);
    console.log("Re-run with BACKFILL_APPLY=1 to write.");
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  const now = new Date();
  for (const l of leads) {
    await prisma.$transaction(async (tx) => {
      await tx.quote.create({
        data: {
          leadId: l.id,
          treatment: treatmentFor(l),
          status: "converted",
          cycle: 1,
          source: "ad", // best-effort: the original enquiry that brought them in
          ownerRepId: l.assignedRepId ?? null,
          convertedAt: l.updatedAt, // best-effort — we don't have the true date
          lockedAt: now,
        },
      });
      await tx.lead.update({
        where: { id: l.id },
        data: { stage: NEW_LEAD_STAGE, stageChangedAt: now, stageStuckNotifiedAt: null },
      });
    });
    done++;
    if (done % 25 === 0) console.log(`  …${done}/${leads.length}`);
  }
  console.log(`\nDone. Backfilled ${done} lead(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
