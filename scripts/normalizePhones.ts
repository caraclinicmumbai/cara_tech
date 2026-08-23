// Bring stored phone numbers into E.164, the shape carriers accept.
//
// Numbers used to be saved exactly as typed — "9536108238", "+91 7506452973" — and
// handed to Twilio/ElevenLabs unchanged, where a malformed destination fails the
// leg silently. New writes are normalised at intake and on edit; this repairs the
// records already in the database.
//
// Only unambiguous rewrites are made: whitespace/punctuation stripped, and a bare
// 10-digit mobile read as +91 (this is an India-only clinic). Anything that can't
// be read that way is REPORTED, never guessed at — including the `+1`-prefixed
// Indian mobiles that caused the silent click-to-call failures, because "which
// country did they mean" is a question for a human with the patient's file.
//
// Dry run:  ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/normalizePhones.ts
// Apply:    ...same... scripts/normalizePhones.ts --apply
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { dialablePhone, implausibleReason } from "../lib/phone";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

type Row = { id: string; name: string; phone: string };

function classify(phone: string): { action: "ok" | "rewrite" | "review"; to?: string; why?: string } {
  const e164 = dialablePhone(phone);
  if (!e164) return { action: "review", why: "not a number we can read" };
  const bad = implausibleReason(e164);
  if (bad) return { action: "review", why: bad };
  if (e164 === phone) return { action: "ok" };
  return { action: "rewrite", to: e164 };
}

async function sweep(label: string, rows: Row[], save: (id: string, phone: string) => Promise<unknown>) {
  const rewrite: string[] = [];
  const review: string[] = [];
  let ok = 0;

  for (const row of rows) {
    const verdict = classify(row.phone);
    if (verdict.action === "ok") {
      ok++;
    } else if (verdict.action === "rewrite") {
      rewrite.push(`  ${row.name.padEnd(28)} ${row.phone.padEnd(18)} → ${verdict.to}`);
      if (APPLY) await save(row.id, verdict.to!);
    } else {
      review.push(`  ${row.name.padEnd(28)} ${row.phone.padEnd(18)} — ${verdict.why}`);
    }
  }

  console.log(`\n${label}: ${rows.length} record(s) — ${ok} already fine, ${rewrite.length} to normalise, ${review.length} needing a human`);
  if (rewrite.length) {
    console.log(APPLY ? " normalised:" : " would normalise:");
    console.log(rewrite.join("\n"));
  }
  if (review.length) {
    console.log(" NEEDS A HUMAN (left untouched — fix these on the record):");
    console.log(review.join("\n"));
  }
}

async function main() {
  console.log(APPLY ? "APPLYING changes" : "DRY RUN — pass --apply to write");

  const leads = await prisma.lead.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, phone: true },
    orderBy: { createdAt: "asc" },
  });
  await sweep("Leads", leads, (id, phone) => prisma.lead.update({ where: { id }, data: { phone } }));

  const reps = await prisma.salesRep.findMany({ select: { id: true, name: true, phone: true } });
  await sweep("Sales reps", reps, (id, phone) => prisma.salesRep.update({ where: { id }, data: { phone } }));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
