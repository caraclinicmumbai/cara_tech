// One-off repair for template messages logged before the thread stored their text.
//
// Until §3.1.3 was fixed, an outbound template was logged as "[template] <name>",
// so the chat showed which template an agent picked rather than what the patient
// read. New sends now store the rendered body; this rewrites the historical rows
// with the template's approved body text.
//
// The parameter VALUES those sends used weren't recorded, so any {{n}} stays a
// visible placeholder — still far more useful than a bare template name. Rows
// whose template is no longer approved (or can't be fetched) are left alone.
//
// Run: ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/backfillTemplateBodies.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { listApprovedTemplates } from "../lib/whatsappTemplates";

const prisma = new PrismaClient();

async function main() {
  const templates = await listApprovedTemplates();
  if (templates.length === 0) {
    console.error("No approved templates available (WABA not configured?) — nothing to do.");
    process.exit(1);
  }

  const rows = await prisma.message.findMany({
    where: { type: "template", templateName: { not: null }, body: { startsWith: "[template] " } },
    select: { id: true, templateName: true },
  });
  console.log(`${rows.length} legacy template message(s) to repair`);

  let fixed = 0;
  const skipped = new Set<string>();
  for (const row of rows) {
    const tpl = templates.find((t) => t.name === row.templateName);
    if (!tpl?.bodyText) {
      skipped.add(row.templateName ?? "?");
      continue;
    }
    await prisma.message.update({ where: { id: row.id }, data: { body: tpl.bodyText } });
    fixed++;
  }

  console.log(`repaired ${fixed}`);
  if (skipped.size > 0) console.log(`skipped (template not approved / not found): ${[...skipped].join(", ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
