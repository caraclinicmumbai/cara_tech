// Make the AuditLog table APPEND-ONLY at the database level (§compliance immutability).
// Installs a Postgres trigger that raises an exception on any UPDATE or DELETE of an
// audit row — so nothing the application does (not even a CRM admin) can edit or delete
// a log entry; the write simply fails. Combined with the hash chain (lib/audit.ts), any
// out-of-band tampering by a DBA is still DETECTABLE via verifyAuditChain().
//
// Idempotent. Run after every deploy that could recreate the table:
//   npm run protect:audit
import { prisma } from "@/lib/prisma";

// Discrete statements — the function body has its own semicolons, so it must be sent as
// a single statement (never split on ";").
const STATEMENTS = [
  `CREATE OR REPLACE FUNCTION cara_audit_append_only() RETURNS trigger AS $BODY$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only — % is not permitted on audit records', TG_OP
    USING ERRCODE = 'check_violation';
END;
$BODY$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS cara_audit_no_update ON "AuditLog"`,
  `CREATE TRIGGER cara_audit_no_update BEFORE UPDATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION cara_audit_append_only()`,
  `DROP TRIGGER IF EXISTS cara_audit_no_delete ON "AuditLog"`,
  `CREATE TRIGGER cara_audit_no_delete BEFORE DELETE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION cara_audit_append_only()`,
  // Also block TRUNCATE — otherwise the whole log could be wiped in one statement.
  `DROP TRIGGER IF EXISTS cara_audit_no_truncate ON "AuditLog"`,
  `CREATE TRIGGER cara_audit_no_truncate BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION cara_audit_append_only()`,
];

async function main() {
  for (const stmt of STATEMENTS) {
    await prisma.$executeRawUnsafe(stmt);
  }

  // Prove it: an UPDATE and a DELETE must both fail now.
  let updateBlocked = false;
  let deleteBlocked = false;
  try {
    await prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET action = action WHERE true`);
  } catch {
    updateBlocked = true;
  }
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE true`);
  } catch {
    deleteBlocked = true;
  }

  console.log(`AuditLog append-only trigger installed. UPDATE blocked: ${updateBlocked}, DELETE blocked: ${deleteBlocked}`);
  if (!updateBlocked || !deleteBlocked) {
    console.error("WARNING: trigger did not block a mutation — investigate before relying on immutability.");
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main();
