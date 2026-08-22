// Give every ownerless lead a counsellor (§3.1 RBAC).
//
// Ownership is assigned round-robin at intake, but leads created before that
// existed — and any created while the whole roster was on break/offline, which
// used to leave them unassigned — have no owner. An ownerless lead is invisible
// in "my leads", has nobody to follow up, and gives a later handover no one to
// notify. This walks them oldest-first and assigns them the same way intake does.
//
// Dry run:  ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/backfillLeadOwners.ts
// Apply:    ...same... scripts/backfillLeadOwners.ts --apply
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { pickOwnerRep, assignLeadToRep } from "../lib/salesReps";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const reps = await prisma.salesRep.count({ where: { active: true, salesHead: false } });
  if (reps === 0) {
    console.error("No active sales reps on the roster — nothing to assign to.");
    process.exit(1);
  }

  const leads = await prisma.lead.findMany({
    where: { assignedRepId: null, deletedAt: null },
    select: { id: true, name: true, source: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`${leads.length} ownerless lead(s); ${reps} active rep(s)${APPLY ? "" : "  [dry run — pass --apply]"}`);

  for (const lead of leads) {
    // Presence is about who can act right now; these are historical leads, so spread
    // them evenly across the whole active roster instead of onto whoever is online.
    const owner = await pickOwnerRep({ preferAvailable: false });
    if (!owner) {
      console.error(`no rep available for ${lead.id} — stopping`);
      break;
    }
    if (APPLY) await assignLeadToRep(lead.id, owner.id);
    console.log(`${APPLY ? "assigned" : "would assign"}  ${lead.name} (${lead.source ?? "?"}) → ${owner.name}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
