// Seed an initial admin user. Run: npm run db:seed
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../lib/password";

const prisma = new PrismaClient();

async function main() {
  const email = "admin@caraclinic.com";
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Cara Admin",
      role: "admin",
      passwordHash: hashPassword("changeme123"),
    },
  });
  console.log(`Seeded admin user: ${email} (password: changeme123 — change it!)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
