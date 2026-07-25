// Seed the default "Cara Santacruz" branch (§branches) from the values that were
// hardcoded in lib/quotePdf.ts, plus the existing public/razorpay-qr.png, and mark it
// default. Idempotent (upsert by code "SCZ"). Existing users/quotes with no branch fall
// back to the default, so quote PDFs are unchanged; this also backfills users' home
// branch so their NEW quotes carry an explicit branch.
//
// Run: npm run seed:branch
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

async function main() {
  const qrPath = join(process.cwd(), "public", "razorpay-qr.png");
  const qr = existsSync(qrPath) ? readFileSync(qrPath) : null;

  const data = {
    name: "Cara Santacruz",
    isDefault: true,
    active: true,
    legalName: "Cara Healthcare Private Limited",
    addressLine1: "Linking Road, Santacruz West",
    city: "Mumbai",
    bankAccountName: "Cara Healthcare Private Limited",
    bankAccountNumber: "020905011291",
    bankIfsc: "ICIC0000209",
    bankName: "ICICI Bank, Santacruz West, Mumbai",
    ...(qr ? { qrImage: qr } : {}),
  };

  const branch = await prisma.branch.upsert({
    where: { code: "SCZ" },
    update: data,
    create: { code: "SCZ", ...data },
    select: { id: true, name: true },
  });

  // Ensure it's the only default.
  await prisma.branch.updateMany({ where: { isDefault: true, NOT: { id: branch.id } }, data: { isDefault: false } });

  // Backfill: staff logins with no home branch → this default branch.
  const backfilled = await prisma.user.updateMany({ where: { branchId: null }, data: { branchId: branch.id } });

  console.log(`Seeded default branch "${branch.name}" (SCZ)${qr ? " with QR" : " (no QR file found)"}.`);
  console.log(`Backfilled ${backfilled.count} user(s) with no branch → SCZ.`);
  await prisma.$disconnect();
}

main();
