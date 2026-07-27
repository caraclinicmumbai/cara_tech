// One test login per RBAC role, all sharing a known password for local testing.
// Run: ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/seedTestUsers.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/password";
import { ROLES, ROLE_LABELS } from "../lib/rbac";

const prisma = new PrismaClient();
const PASSWORD = "changeme123";

async function main() {
  for (const role of ROLES) {
    const email = `${role.replace(/_/g, "-")}@caraclinic.com`;
    await prisma.user.upsert({
      where: { email },
      update: { passwordHash: hashPassword(PASSWORD), role },
      create: {
        email,
        name: `Test ${ROLE_LABELS[role]}`,
        role,
        passwordHash: hashPassword(PASSWORD),
      },
    });
    console.log(`${role.padEnd(15)} → ${email} / ${PASSWORD}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
