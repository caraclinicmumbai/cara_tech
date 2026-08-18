// One-time backfill for the post-sales ERP cutover (§post-sales).
//
// Quotes that converted BEFORE the post-sales journey existed have no journey, so their
// patients are invisible to the clinical team — exactly the failure the spec calls out
// ("every converted patient is in the post-sales pipeline automatically"). This opens the
// missing journey for each of them.
//
// Each journey opens at the `converted` stage with its stage clock armed from the
// treatment's policy, and gets a handover summary generated. It does NOT invent a
// surgery date or a check-in schedule: nobody knows when (or whether) those surgeries
// happened, and guessing would fire day-1 post-op messages at patients who are months
// past it. The post-sales team advances each journey and records the real surgery date,
// which generates the schedule from that point.
//
// Idempotent: openJourneyForQuote() is a no-op when a journey already exists (unique
// index on quoteId), so re-running is safe.
//
// Usage:
//   npx tsx scripts/backfillPostSalesJourneys.ts                    # dry run
//   BACKFILL_APPLY=1 npx tsx scripts/backfillPostSalesJourneys.ts   # live
//
// Env: DATABASE_URL must be loaded (e.g. `set -a; . ./.env.local; set +a`).

import { prisma } from "../lib/prisma";
import { openJourneyForQuote } from "../lib/postSales/journeys";
import { resolveTreatmentType } from "../lib/postSales/policy";

const APPLY = process.env.BACKFILL_APPLY === "1";

/// Quote statuses that mean the treatment was WON and so should have a journey.
const WON = ["converted", "in_treatment", "completed"];

async function main() {
  const orphans = await prisma.quote.findMany({
    where: {
      status: { in: WON },
      journey: null,
      // A deleted patient record isn't brought back into the clinical pipeline.
      lead: { deletedAt: null },
    },
    orderBy: { convertedAt: "asc" },
    select: {
      id: true,
      treatment: true,
      status: true,
      convertedAt: true,
      createdAt: true,
      lead: { select: { name: true } },
      branch: { select: { name: true } },
      invoicedBranch: { select: { name: true } },
    },
  });

  console.log(
    `Found ${orphans.length} converted quote(s) with no post-sales journey.${APPLY ? "" : "  (dry run — nothing will be written)"}`,
  );
  if (orphans.length === 0) return;

  // Group by resolved policy key so the operator can see which timings each will get.
  const byType = new Map<string, number>();
  for (const q of orphans) {
    const key = resolveTreatmentType(q.treatment);
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  console.log("\nBy treatment policy:");
  for (const [key, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(18)} ${n}`);
  }

  console.log("\nSample (up to 10):");
  for (const q of orphans.slice(0, 10)) {
    const branch = q.invoicedBranch?.name ?? q.branch?.name ?? "no branch";
    const when = (q.convertedAt ?? q.createdAt).toISOString().slice(0, 10);
    console.log(`  ${q.lead.name} — ${q.treatment} (${q.status}, ${when}, ${branch})`);
  }

  if (!APPLY) {
    console.log("\nRe-run with BACKFILL_APPLY=1 to open these journeys.");
    return;
  }

  let opened = 0;
  let failed = 0;
  for (const q of orphans) {
    try {
      const id = await openJourneyForQuote(q.id);
      if (id) opened++;
      else console.warn(`  skipped quote ${q.id} (not eligible)`);
    } catch (err) {
      failed++;
      console.error(`  FAILED quote ${q.id}: ${String(err)}`);
    }
  }

  console.log(`\nOpened ${opened} journey(ies)${failed ? `, ${failed} failed` : ""}.`);
  console.log(
    "Each is at the Converted stage. The post-sales team should assign a consultant, advance the stage, and record\n" +
      "the real surgery date — that is what generates the day 1/7/30/90 check-in schedule.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
