// Producing the database dump itself (§backups).
//
// Two modes, and the reason there are two is deployment rather than taste. Railway
// builds this repo with Railpack, whose image carries Node and not the Postgres client
// tools — so `pg_dump` is only there if somebody sets
// `RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client-17` on the service. That is one
// console field away from being forgotten, and a backup system whose failure mode is
// "no backups at all, quietly" is not one.
//
// So: **pg_dump when it is available and new enough** (custom format, restorable with
// `pg_restore`, the real thing) — otherwise a **portable dump** this repo writes
// itself, which is worse but is not nothing. Every run says in Slack which mode it
// used, so "we are on the fallback" can't become the permanent state by accident.
import { spawn } from "child_process";
import { PassThrough, type Readable } from "stream";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export type DumpMode = "pg_dump" | "portable";

/// `pg_dump` speaks libpq, which rejects a URI carrying query parameters it doesn't
/// know — and Prisma's URLs routinely carry `schema`, `connection_limit`, `pgbouncer`
/// and friends. Strip everything libpq wouldn't recognise rather than hand it a URL it
/// will refuse.
const LIBPQ_PARAMS = new Set([
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "connect_timeout",
  "application_name",
  "options",
  "target_session_attrs",
  "host",
  "hostaddr",
  "port",
]);

export function libpqUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (!LIBPQ_PARAMS.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

/// The major version of the `pg_dump` on PATH, or null when there isn't one.
export async function pgDumpVersion(): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("pg_dump", ["--version"]);
    let out = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const m = out.match(/(\d+)(?:\.\d+)?/);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

/// The major version of the server we're dumping.
export async function serverVersion(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ v: string }[]>("SHOW server_version");
    const m = rows[0]?.v?.match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  } catch (err) {
    logger.error(`Backup: could not read server_version: ${String(err)}`);
    return null;
  }
}

/// Can pg_dump be used? It refuses to dump a server newer than itself, so a v16
/// client against a v17 server is a failure we should predict rather than discover
/// halfway through a scheduled run.
export async function chooseMode(): Promise<{ mode: DumpMode; reason: string }> {
  const client = await pgDumpVersion();
  if (client === null) {
    return {
      mode: "portable",
      reason:
        "pg_dump is not installed in this image — set RAILPACK_DEPLOY_APT_PACKAGES=postgresql-client-17 on the worker service",
    };
  }
  const server = await serverVersion();
  if (server !== null && client < server) {
    return {
      mode: "portable",
      reason: `pg_dump is v${client} but the server is v${server}; pg_dump refuses to dump a newer server`,
    };
  }
  return { mode: "pg_dump", reason: `pg_dump v${client}` };
}

/// A pg_dump custom-format archive, streamed. Already compressed by pg_dump, so
/// nothing gzips it afterwards. Restore with `pg_restore`.
export function pgDumpStream(databaseUrl: string): Readable {
  const out = new PassThrough();
  const proc = spawn(
    "pg_dump",
    [
      "--format=custom",
      "--compress=6",
      // The restore target is a fresh Railway database with a different owner, and
      // roles/grants from the old one only make it fail.
      "--no-owner",
      "--no-privileges",
      libpqUrl(databaseUrl),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += String(d)));
  proc.on("error", (err) => out.destroy(err));
  proc.on("close", (code) => {
    if (code !== 0) out.destroy(new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 500)}`));
  });
  proc.stdout.pipe(out);
  return out;
}

/// Rows the portable dump never carries. Migration history is rebuilt by
/// `prisma migrate deploy` on restore, and copying the old rows on top of that only
/// produces a primary-key conflict.
const SKIP_TABLES = new Set(["_prisma_migrations"]);

/// How many rows are read from a table at a time. Small enough that a wide table
/// (transcripts, QR image bytes) doesn't arrive in one allocation.
const PAGE = 500;

export async function listTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows
    .map((r) => r.tablename)
    .filter((t) => !SKIP_TABLES.has(t))
    // The name is interpolated into the page query below — it comes from our own
    // catalogue, but a name that can't be quoted safely is dropped rather than sent.
    .filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t));
}

/// The fallback dump: newline-delimited JSON, one row per line, produced by Postgres
/// itself via `row_to_json` so that types survive the round trip — `bytea` comes back
/// as `\x…`, timestamps as ISO, `Decimal` unrounded — none of which is true if
/// JavaScript does the serialising.
///
/// Consistency comes from reading every table inside ONE repeatable-read transaction:
/// paging through tables one at a time otherwise gives a dump where a lead exists and
/// the call that created it doesn't.
///
/// Ends with a footer line naming the row count. Restore refuses a file without it,
/// which is how a half-uploaded object gets caught.
export function portableDumpStream(): Readable {
  const out = new PassThrough();

  void (async () => {
    const started = new Date();
    let total = 0;
    try {
      const tables = await listTables();
      // Backpressure: PassThrough.write() returns false when the consumer is behind,
      // and this waits for drain rather than reading the whole database into memory.
      const write = (line: string) =>
        new Promise<void>((resolve, reject) => {
          if (out.write(line)) return resolve();
          out.once("drain", resolve);
          out.once("error", reject);
        });

      await write(
        JSON.stringify({ caraBackup: 1, mode: "portable", startedAt: started.toISOString(), tables }) + "\n",
      );

      await prisma.$transaction(
        async (tx) => {
          for (const table of tables) {
            let offset = 0;
            for (;;) {
              // ORDER BY ctid gives every table a total order without needing to know
              // its primary key; the snapshot makes the paging stable.
              const rows = await tx.$queryRawUnsafe<{ r: unknown }[]>(
                `SELECT row_to_json(t) AS r FROM "${table}" t ORDER BY t.ctid LIMIT ${PAGE} OFFSET ${offset}`,
              );
              if (rows.length === 0) break;
              for (const row of rows) {
                await write(JSON.stringify({ t: table, r: row.r }) + "\n");
                total++;
              }
              offset += rows.length;
              if (rows.length < PAGE) break;
            }
          }
        },
        {
          isolationLevel: "RepeatableRead",
          timeout: Number(process.env.BACKUP_TX_TIMEOUT_MS ?? 15 * 60_000),
          maxWait: 30_000,
        },
      );

      await write(JSON.stringify({ caraBackupEnd: 1, rows: total }) + "\n");
      out.end();
      logger.info(`Backup: portable dump wrote ${total} rows across ${tables.length} tables`);
    } catch (err) {
      out.destroy(err as Error);
    }
  })();

  return out;
}
