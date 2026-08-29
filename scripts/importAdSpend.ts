// Import daily ad spend from a CSV (§reports, Source Attribution).
//
// The ad platforms all export a daily breakdown; this takes that export and fills the
// cost side of the attribution report. Expected columns (header row required, order
// and extra columns don't matter, names are matched case/space-insensitively):
//
//   day        YYYY-MM-DD, or DD/MM/YYYY   (aliases: date, reporting_starts)
//   source     facebook | instagram | google  (alias: platform, channel)
//   amount     rupees, digits and decimals    (aliases: spend, cost, amount_spent)
//   campaign   optional — omit for a source's daily total (alias: campaign_name)
//   branch     optional — a branch CODE (e.g. SCZ)
//
// **Import a 0 for every day a source ran nothing.** A day with no row is treated as
// unknown, and the report withholds every cost figure covering it — which is the whole
// point: a missing day quietly counted as zero makes a channel look cheaper than it is.
// `--zero-fill` does this for you across the range the file covers.
//
// Dry run:  ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/importAdSpend.ts spend.csv
// Apply:    ...same... scripts/importAdSpend.ts spend.csv --apply [--zero-fill]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { recordAdSpend, AdSpendError } from "../lib/adSpend";
import { PAID_SOURCES } from "../lib/reports/shared";
import { daysBetween } from "../lib/reports/range";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ZERO_FILL = args.includes("--zero-fill");
const file = args.find((a) => !a.startsWith("--"));

type Row = { day: string; source: string; campaign: string; amount: number; branch: string | null };

/// A CSV line splitter that respects double quotes — campaign names contain commas.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/// Header matching is deliberately forgiving: platform exports ship names like
/// "Amount spent (INR)" and "Reporting starts", so everything but letters and digits
/// is dropped before comparing.
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const ALIASES: Record<string, string[]> = {
  day: ["day", "date", "reportingstarts", "reportingdate"],
  source: ["source", "platform", "channel", "network"],
  amount: ["amount", "spend", "cost", "amountspent", "amountspentinr", "totalspend"],
  campaign: ["campaign", "campaignname", "campaignid"],
  branch: ["branch", "branchcode"],
};

function columnIndex(header: string[], field: keyof typeof ALIASES): number {
  const wanted = ALIASES[field];
  return header.findIndex((h) => wanted.includes(norm(h)));
}

/// Accepts YYYY-MM-DD and DD/MM/YYYY (what the Indian platform exports give).
function parseDay(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

/// The platform's own name for itself → the CRM's lead source.
const SOURCE_MAP: Record<string, string> = {
  facebook: "facebook",
  fb: "facebook",
  meta: "facebook",
  instagram: "instagram",
  ig: "instagram",
  google: "google",
  googleads: "google",
  adwords: "google",
  youtube: "google",
};

function parseAmount(raw: string): number | null {
  // Strip currency symbols, thousands separators and stray spaces.
  const cleaned = raw.replace(/[₹$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function main() {
  if (!file) {
    console.error("Usage: importAdSpend.ts <file.csv> [--apply] [--zero-fill]");
    process.exit(1);
  }

  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    console.error("File has no data rows.");
    process.exit(1);
  }

  const header = splitCsvLine(lines[0]);
  const idx = {
    day: columnIndex(header, "day"),
    source: columnIndex(header, "source"),
    amount: columnIndex(header, "amount"),
    campaign: columnIndex(header, "campaign"),
    branch: columnIndex(header, "branch"),
  };
  for (const required of ["day", "source", "amount"] as const) {
    if (idx[required] < 0) {
      console.error(
        `Missing a "${required}" column. Found: ${header.join(", ")}\n` +
          `Accepted names: ${ALIASES[required].join(", ")}`,
      );
      process.exit(1);
    }
  }

  const rows: Row[] = [];
  const skipped: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const day = parseDay(cells[idx.day] ?? "");
    const rawSource = norm(cells[idx.source] ?? "");
    const source = SOURCE_MAP[rawSource] ?? rawSource;
    const amount = parseAmount(cells[idx.amount] ?? "");

    if (!day) { skipped.push(`line ${i + 1}: unreadable date "${cells[idx.day]}"`); continue; }
    if (!PAID_SOURCES.includes(source)) { skipped.push(`line ${i + 1}: unknown source "${cells[idx.source]}"`); continue; }
    if (amount == null) { skipped.push(`line ${i + 1}: unreadable amount "${cells[idx.amount]}"`); continue; }

    rows.push({
      day,
      source,
      campaign: idx.campaign >= 0 ? (cells[idx.campaign] ?? "").trim() : "",
      amount,
      branch: idx.branch >= 0 ? (cells[idx.branch] ?? "").trim() || null : null,
    });
  }

  if (rows.length === 0) {
    console.error(`No usable rows.\n${skipped.join("\n")}`);
    process.exit(1);
  }

  // Branch CODES → ids, so the CSV can carry "SCZ" rather than a cuid.
  const branchCodes = [...new Set(rows.map((r) => r.branch).filter((b): b is string => !!b))];
  const branches = branchCodes.length
    ? await prisma.branch.findMany({
        where: { code: { in: branchCodes } },
        select: { id: true, code: true },
      })
    : [];
  const branchId = new Map(branches.map((b) => [b.code, b.id]));
  for (const code of branchCodes) {
    if (!branchId.has(code)) skipped.push(`unknown branch code "${code}" — those rows import with no branch`);
  }

  const dayKeys = rows.map((r) => r.day).sort();
  const first = dayKeys[0];
  const last = dayKeys[dayKeys.length - 1];

  // Zero-fill: every (day, source) in the covered range that the file didn't mention.
  // Without this, one quiet Sunday makes the whole range's cost "unavailable".
  const filled: Row[] = [];
  if (ZERO_FILL) {
    const present = new Set(rows.map((r) => `${r.day}|${r.source}`));
    const sourcesInFile = [...new Set(rows.map((r) => r.source))];
    for (const day of daysBetween(first, last)) {
      for (const source of sourcesInFile) {
        if (!present.has(`${day}|${source}`)) filled.push({ day, source, campaign: "", amount: 0, branch: null });
      }
    }
  }

  const all = [...rows, ...filled];
  const total = rows.reduce((s, r) => s + r.amount, 0);

  console.log(`File:        ${file}`);
  console.log(`Range:       ${first} → ${last} (${daysBetween(first, last).length} days)`);
  console.log(`Rows:        ${rows.length} read${filled.length ? `, ${filled.length} zero-filled` : ""}`);
  console.log(`Sources:     ${[...new Set(rows.map((r) => r.source))].join(", ")}`);
  // Whole rupees, matching what actually gets stored.
  console.log(`Total spend: ₹${Math.round(total).toLocaleString("en-IN")}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped.slice(0, 20)) console.log(`  · ${s}`);
    if (skipped.length > 20) console.log(`  · …and ${skipped.length - 20} more`);
  }
  if (!ZERO_FILL) {
    console.log(
      "\nNote: days this file doesn't mention stay UNKNOWN and the report withholds cost " +
        "figures covering them. Pass --zero-fill if the gaps are genuinely days with no spend.",
    );
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  let created = 0;
  let replaced = 0;
  let failed = 0;
  for (const r of all) {
    try {
      const res = await recordAdSpend({
        day: r.day,
        source: r.source,
        campaign: r.campaign,
        amount: r.amount,
        branchId: r.branch ? (branchId.get(r.branch) ?? null) : null,
        importedFrom: "csv",
      });
      if (res.replaced) replaced += 1;
      else created += 1;
    } catch (err) {
      failed += 1;
      if (err instanceof AdSpendError) console.error(`  ✗ ${r.day} ${r.source}: ${err.message}`);
      else throw err;
    }
  }
  console.log(`\nDone: ${created} recorded, ${replaced} replaced${failed ? `, ${failed} failed` : ""}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
