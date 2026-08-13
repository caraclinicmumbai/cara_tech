// One-time backfill: seed the follow-up roadmap onto EXISTING active leads that
// don't have one yet (§follow-up roadmap). New leads are seeded automatically at
// intake; this covers records created before the feature shipped.
//
// Choices (deliberate):
//  • Target only actively-pursued leads: not deleted, not a duplicate, not held,
//    and stage NOT lost/converted. Idempotent — leads that already have steps are
//    skipped by the query.
//  • Dates run FORWARD from today (not the lead's creation date) so the roadmap is
//    a forward-looking plan, not a wall of already-"missed" red steps.
//  • AI-call steps are skipped by default (INCLUDE_AI=true to keep them): existing
//    leads are past the AI-contact phase, so a pending "AI first call" would mislead.
//
// Usage:
//   DATABASE_URL=<prod-url> DRY_RUN=true  npx tsx scripts/backfillFollowUps.ts   # preview (no writes)
//   DATABASE_URL=<prod-url> DRY_RUN=false npx tsx scripts/backfillFollowUps.ts   # execute
import { prisma } from "@/lib/prisma";
import { FOLLOWUP_TEMPLATE } from "@/lib/followups";
import { getSalesHead } from "@/lib/salesReps";

const DAY_MS = 24 * 60 * 60 * 1000;
const DRY = process.env.DRY_RUN !== "false"; // default: dry run
const INCLUDE_AI = process.env.INCLUDE_AI === "true"; // default: skip AI steps

async function main() {
  const now = new Date();
  const salesHead = await getSalesHead();

  const template = FOLLOWUP_TEMPLATE.filter((t) => INCLUDE_AI || t.ownerKind !== "ai");

  const leads = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      duplicateOfId: null,
      heldForReview: false,
      stage: { notIn: ["lost", "converted"] },
      followUpSteps: { none: {} }, // idempotent: skip leads that already have a roadmap
    },
    select: { id: true, assignedRepId: true },
  });

  console.log(`Mode: ${DRY ? "DRY RUN (no writes)" : "EXECUTE"} · includeAI=${INCLUDE_AI}`);
  console.log(`Sales head resolved: ${salesHead ? salesHead.name : "(none configured)"}`);
  console.log(`Steps per lead (${template.length}): ${template.map((t) => t.title).join(" | ")}`);
  console.log(`Candidate leads (active, no existing roadmap): ${leads.length}`);
  console.log(`Total rows that would be created: ${leads.length * template.length}`);

  if (DRY) {
    console.log("\nDRY RUN — nothing written. Re-run with DRY_RUN=false to execute.");
    await prisma.$disconnect();
    return;
  }

  // Build every row up front, then insert in large chunks — far fewer round trips
  // than a createMany per lead (which is too slow over a remote DB proxy).
  const allRows = leads.flatMap((lead) =>
    template.map((t, i) => ({
      leadId: lead.id,
      order: i,
      title: t.title,
      channel: t.channel,
      dueAt: new Date(now.getTime() + t.dayOffset * DAY_MS),
      ownerKind: t.ownerKind,
      ownerRepId:
        t.ownerKind === "rep" ? lead.assignedRepId : t.ownerKind === "sales_head" ? (salesHead?.id ?? null) : null,
      source: "template",
    })),
  );

  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const batch = allRows.slice(i, i + CHUNK);
    await prisma.leadFollowUpStep.createMany({ data: batch });
    inserted += batch.length;
    console.log(`  …inserted ${inserted}/${allRows.length} rows`);
  }
  console.log(`\n✅ Seeded roadmaps for ${leads.length} leads (${inserted} rows).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
