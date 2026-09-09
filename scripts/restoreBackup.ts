// Restore — or just list, or verify — a database backup (§backups).
//
// The half of a backup system that people skip and then discover, at the worst
// possible moment, doesn't work. Three commands:
//
//   npm run backup:list                      what's in the bucket
//   npm run backup:verify -- <key>           download, decrypt, read it end to end
//   npm run backup:restore -- <key> <url>    write it into a database
//
// `verify` is the one to run on a schedule you keep. It proves the object downloads,
// the key decrypts it, and the archive is complete — without touching a database.
//
// **Restore never targets DATABASE_URL implicitly.** The target has to be passed in
// full, because the difference between restoring a copy and overwriting production is
// one command, and it should not be one flag either.
import "dotenv/config";
import { spawn } from "child_process";
import { createReadStream, existsSync } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { PrismaClient } from "@prisma/client";
import { storageConfig, listObjects, getObjectStream } from "@/lib/backup/storage";
import { encryptionKey, decryptStream } from "@/lib/backup/crypto";
import { libpqUrl } from "@/lib/backup/dump";
import type { Readable } from "stream";

const cfg = storageConfig();

function die(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

/// The object, decrypted if it needs to be. Everything below reads from here, so the
/// encryption is invisible to the rest of the script.
///
/// A `key` that names a file on disk is read from disk — for when the object has
/// already been pulled down (rclone, the R2 console) and for testing the restore
/// without a bucket in the loop.
async function open(key: string): Promise<Readable> {
  let raw: Readable;
  if (existsSync(key)) {
    raw = createReadStream(key);
  } else {
    if (!cfg) die("BACKUP_S3_* is not configured, and there is no local file at that path");
    raw = await getObjectStream(cfg, key);
  }
  if (!key.endsWith(".enc")) return raw;
  const k = encryptionKey();
  if (!k) die(`${key} is encrypted but BACKUP_ENCRYPTION_KEY is not set — without it this object is noise`);
  return decryptStream(raw, k);
}

async function list(): Promise<void> {
  if (!cfg) die("BACKUP_S3_* is not configured");
  for (const tier of ["daily", "weekly", "monthly"] as const) {
    const objects = (await listObjects(cfg, `${cfg.prefix}/${tier}/`)).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    console.log(`\n${tier} (${objects.length})`);
    if (!objects.length) console.log("  — nothing —");
    for (const o of objects) {
      console.log(`  ${o.key.padEnd(52)} ${(o.size / 1024 / 1024).toFixed(1).padStart(8)} MB  ${o.modified.toISOString()}`);
    }
  }
}

/// Read the whole object. For the portable dump that also means checking the footer,
/// which is the only way to tell a complete file from a truncated upload.
async function verify(key: string): Promise<void> {
  const stream = await open(key);
  let bytes = 0;
  stream.on("data", (c: Buffer) => (bytes += c.length));

  if (key.includes(".ndjson.gz")) {
    let rows = 0;
    let sawFooter = false;
    let declared = 0;
    const lines = createInterface({ input: stream.pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.caraBackup) continue;
      if (obj.caraBackupEnd) {
        sawFooter = true;
        declared = obj.rows;
        continue;
      }
      rows++;
    }
    if (!sawFooter) die(`${key} has no end marker — it is truncated`);
    if (rows !== declared) die(`${key} says ${declared} rows but contains ${rows}`);
    console.log(`✅ ${key} — ${rows} rows, ${(bytes / 1024 / 1024).toFixed(1)} MB, complete`);
    return;
  }

  // A pg_dump archive: let pg_restore parse it. Listing the table of contents reads
  // the whole file and fails on a corrupt one, without writing anything anywhere.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pg_restore", ["--list"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err += String(d)));
    proc.on("error", () => reject(new Error("pg_restore is not installed here — cannot verify a pg_dump archive")));
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_restore --list failed: ${err.trim().slice(0, 300)}`)),
    );
    stream.pipe(proc.stdin);
  });
  console.log(`✅ ${key} — valid pg_dump archive, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
}

async function restorePgDump(key: string, target: string): Promise<void> {
  const stream = await open(key);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "pg_restore",
      ["--dbname", libpqUrl(target), "--no-owner", "--no-privileges", "--clean", "--if-exists"],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore exited ${code}`))));
    stream.pipe(proc.stdin);
  });
}

/// Restore the portable dump. Foreign keys are the problem — rows arrive in table
/// order, not dependency order — so this disables constraint triggers for the session
/// (`session_replication_role = replica`) and turns them back on at the end. The
/// schema itself is NOT in this file: run `prisma migrate deploy` against the target
/// first, which is what makes the repo the source of truth for structure.
async function restorePortable(key: string, target: string): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: target } } });
  const stream = (await open(key)).pipe(createGunzip());

  let rows = 0;
  let sawFooter = false;
  let declared = 0;

  try {
    // One interactive transaction for the whole restore. Two reasons, both of which
    // bit: it pins a single connection, so `SET LOCAL session_replication_role` is
    // still in force for the inserts that follow (Prisma otherwise hands each query
    // whatever connection is free) — and a restore that fails halfway rolls back
    // rather than leaving the target half-populated, which is the worst possible
    // state to discover a database in.
    await prisma.$transaction(
      async (tx) => {
        // Rows arrive in table order, not dependency order, so foreign keys have to
        // stand down for the duration. This needs a privileged role; Railway's
        // Postgres user has it, a locked-down one may not — hence the explicit error.
        try {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        } catch {
          throw new Error(
            "this database role cannot SET session_replication_role, which the restore needs to " +
              "load rows out of dependency order — restore as the database owner/superuser",
          );
        }

        // NOTE: createInterface starts draining the stream the moment it exists, and
        // lines emitted before the `for await` attaches its iterator are dropped on
        // the floor. So it is built here, with nothing awaited between.
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          const obj = JSON.parse(line);

          if (obj.caraBackup) {
            // The header names every table in the dump. Empty all of them up front,
            // so tables that are empty in the backup end up empty here too — clearing
            // lazily on first row would silently leave their old contents behind.
            for (const t of obj.tables as string[]) {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`refusing odd table name ${t}`);
              await tx.$executeRawUnsafe(`DELETE FROM "${t}"`);
            }
            continue;
          }
          if (obj.caraBackupEnd) {
            sawFooter = true;
            declared = obj.rows;
            continue;
          }

          const table: string = obj.t;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`refusing odd table name ${table}`);
          await tx.$executeRawUnsafe(
            `INSERT INTO "${table}" SELECT * FROM json_populate_record(null::"${table}", $1::json)`,
            JSON.stringify(obj.r),
          );
          rows++;
          if (rows % 1000 === 0) console.log(`  … ${rows} rows`);
        }

        if (!sawFooter) throw new Error("the dump has no end marker — it is truncated; nothing was written");
        if (rows !== declared) throw new Error(`dump says ${declared} rows, restored ${rows}`);
      },
      {
        timeout: Number(process.env.RESTORE_TX_TIMEOUT_MS ?? 30 * 60_000),
        maxWait: 30_000,
      },
    );
  } finally {
    await prisma.$disconnect();
  }
  console.log(`✅ restored ${rows} rows from ${key}`);
}

async function main() {
  const [command, key, target] = process.argv.slice(2);

  if (command === "list") return list();
  if (command === "verify") {
    if (!key) die("usage: backup:verify -- <key>");
    return verify(key);
  }
  if (command === "restore") {
    if (!key || !target) {
      die(
        "usage: backup:restore -- <key> <target-database-url>\n" +
          "   the target URL is required in full; this never falls back to DATABASE_URL",
      );
    }
    console.log(`Restoring ${key} into ${new URL(target).host} …`);
    if (key.includes(".ndjson.gz")) {
      console.log("(portable dump — run `prisma migrate deploy` against the target FIRST)");
      return restorePortable(key, target);
    }
    return restorePgDump(key, target);
  }

  die("usage: backup:list | backup:verify -- <key> | backup:restore -- <key> <url>");
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
