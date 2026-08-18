// Grant NEWLY-INTRODUCED capabilities to roles an admin has already customised.
//
// THE PROBLEM THIS SOLVES
// `RolePermission` rows are authoritative: `buildMatrix()` in lib/permissions.ts uses a
// row's capability list VERBATIM and ignores the built-in defaults for that role. That is
// correct for a capability the admin made a decision about — if they revoked
// `leads.export`, a deploy must not hand it back.
//
// But it means a capability that did not EXIST when the row was saved never reaches that
// role. The admin cannot have had an opinion about a key that wasn't in the matrix yet, so
// silently withholding it is wrong: the role simply loses the new feature, and the only
// symptom is staff saying "it doesn't work for us".
//
// This script unions in ONLY the keys listed in NEW_CAPABILITIES below, and only where the
// role gets them BY DEFAULT. It never removes anything and never grants a role something
// its defaults don't include, so no admin decision is overridden.
//
// It also REPORTS (without changing) any customised role that is missing a capability a
// top-level route now requires — a lockout risk that is a judgement call for a human, not
// something a script should quietly patch.
//
// WHEN ADDING CAPABILITIES IN FUTURE: add the new keys to NEW_CAPABILITIES and re-run.
//
// Usage:
//   npx tsx scripts/backfillRoleCapabilities.ts                    # dry run
//   BACKFILL_APPLY=1 npx tsx scripts/backfillRoleCapabilities.ts   # live
//
// Env: DATABASE_URL must be loaded (the npm script wraps this in dotenv).

import { prisma } from "../lib/prisma";
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  routeCapability,
  type Capability,
  type Role,
} from "../lib/rbac";
import { writeAudit } from "../lib/audit";

const APPLY = process.env.BACKFILL_APPLY === "1";

/// Capabilities introduced after the Hierarchy screen shipped, which therefore may be
/// absent from override rows saved before them. Post-sales ERP, 2026-08-18.
const NEW_CAPABILITIES: Capability[] = [
  "postsales.view",
  "postsales.manage",
  "postsales.checkins",
  "postsales.policy",
];

/// Every capability that now gates a top-level route. A customised role missing one of
/// these can't reach that section at all — worth a human's attention.
const ROUTE_GATES: { path: string; cap: Capability }[] = [
  "/leads",
  "/calls",
  "/dashboard",
  "/post-sales",
  "/campaigns",
  "/audit",
  "/users",
  "/branches",
  "/hierarchy",
  "/settings",
]
  .map((path) => ({ path, cap: routeCapability(path) }))
  .filter((x): x is { path: string; cap: Capability } => x.cap !== null);

function isKnownRole(r: string): r is Role {
  return r in ROLE_CAPABILITIES;
}

async function main() {
  const rows = await prisma.rolePermission.findMany({ orderBy: { role: "asc" } });
  if (rows.length === 0) {
    console.log("No RolePermission override rows — every role uses the built-in defaults. Nothing to do.");
    return;
  }

  console.log(
    `${rows.length} customised role(s).${APPLY ? "" : "  (dry run — nothing will be written)"}\n`,
  );

  const plans: { role: string; add: Capability[]; next: Capability[] }[] = [];
  const lockouts: { role: string; path: string; cap: Capability }[] = [];

  for (const row of rows) {
    if (!isKnownRole(row.role)) {
      console.log(`${row.role}: unknown role (renamed/removed) — skipping.`);
      continue;
    }
    const have = new Set(
      (Array.isArray(row.capabilities) ? row.capabilities : []).filter(
        (c): c is Capability => typeof c === "string" && (CAPABILITIES as readonly string[]).includes(c),
      ),
    );
    const defaults = ROLE_CAPABILITIES[row.role];

    // Only new keys, only where the role has them by default, only if absent.
    const add = NEW_CAPABILITIES.filter((c) => defaults.has(c) && !have.has(c));
    const next = CAPABILITIES.filter((c) => have.has(c) || add.includes(c));

    console.log(`${row.role}  (last saved ${row.updatedAt.toISOString().slice(0, 10)})`);
    console.log(`  will grant: ${add.length ? add.join(", ") : "nothing (already up to date)"}`);
    if (add.length) plans.push({ role: row.role, add, next });

    // Lockout check runs against what the row WILL contain after the backfill.
    const after = new Set(next);
    for (const gate of ROUTE_GATES) {
      if (!after.has(gate.cap)) lockouts.push({ role: row.role, path: gate.path, cap: gate.cap });
    }
  }

  if (lockouts.length) {
    console.log(
      "\n⚠️  Customised roles that cannot reach a gated section. These are NOT changed by this\n" +
        "    script — the admin may have intended them. Review in /hierarchy.\n",
    );
    for (const l of lockouts) {
      const severity = l.path === "/leads" ? "  ← locked out of the LEADS LIST" : "";
      console.log(`    ${l.role.padEnd(16)} ${l.path.padEnd(14)} needs ${l.cap}${severity}`);
    }
  }

  if (!plans.length) {
    console.log("\nNothing to grant.");
    return;
  }
  if (!APPLY) {
    console.log("\nRe-run with BACKFILL_APPLY=1 to apply.");
    return;
  }

  for (const plan of plans) {
    await prisma.rolePermission.update({
      where: { role: plan.role },
      data: { capabilities: plan.next },
    });
    await writeAudit({
      action: "settings.change",
      entityType: "setting",
      entityId: `rolePermission:${plan.role}`,
      field: "capabilities",
      newValue: plan.add.join(", "),
      reason: "Backfill: capabilities introduced after this role was last customised",
      meta: { role: plan.role, granted: plan.add, script: "backfillRoleCapabilities" },
    });
    console.log(`  ✓ ${plan.role}: granted ${plan.add.join(", ")}`);
  }

  console.log(
    `\nUpdated ${plans.length} role(s). The effective matrix is cached for up to 15s ` +
      "(lib/permissions.ts TTL), so signed-in staff pick this up within a few seconds.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
