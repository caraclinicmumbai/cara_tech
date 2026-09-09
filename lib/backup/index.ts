// Daily / weekly / monthly database backups (§backups, gaps O1).
//
// One dump a day, at BACKUP_HOUR_IST. That object is the day's backup; on Sunday it is
// also copied to `weekly/` and on the 1st to `monthly/`, server-side, so a week's or a
// month's copy costs a copy rather than a second dump of the database. Each tier is
// then pruned to its own retention — the classic grandfather-father-son arrangement,
// which is what makes "we noticed the corruption three weeks later" survivable.
//
// Every run reports to Slack. **Failures alert; successes are quiet unless
// BACKUP_REPORT_SUCCESS is set** — an alert nobody reads is how a broken backup goes
// unnoticed for a year, and this one is meant to be read.
import { Queue, type ConnectionOptions } from "bullmq";
import { gzip } from "./gzip";
import { chooseMode, pgDumpStream, portableDumpStream, type DumpMode } from "./dump";
import { encryptionKey, encryptStream } from "./crypto";
import {
  storageConfig,
  isBackupConfigured,
  putStream,
  copyObject,
  listObjects,
  deleteObjects,
  headObject,
  type StorageConfig,
} from "./storage";
import { sendSlack } from "@/lib/slack";
import { branchManagerChannel } from "@/lib/digest";
import { logger } from "@/lib/logger";

export const BACKUP_QUEUE = "database-backup";
export const BACKUP_JOB = "run-backup";

export type Tier = "daily" | "weekly" | "monthly";

export type BackupResult = {
  ok: boolean;
  key?: string;
  bytes?: number;
  mode?: DumpMode;
  encrypted?: boolean;
  tiers: Tier[];
  pruned: string[];
  error?: string;
  seconds: number;
};

const keep = (tier: Tier): number => {
  const raw =
    tier === "daily"
      ? process.env.BACKUP_KEEP_DAILY
      : tier === "weekly"
        ? process.env.BACKUP_KEEP_WEEKLY
        : process.env.BACKUP_KEEP_MONTHLY;
  const n = Number(raw ?? (tier === "daily" ? 7 : tier === "weekly" ? 5 : 12));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
};

export function backupHour(): number {
  const n = Number(process.env.BACKUP_HOUR_IST ?? 2);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : 2;
}

/// Where a backup alert goes: its own channel, else the CRM admin channel, else
/// wherever the branch manager's digest goes. Same ladder the health monitor uses.
function alertChannel(): string | undefined {
  return (
    process.env.BACKUP_ALERT_CHANNEL ||
    process.env.CRM_ADMIN_CHANNEL ||
    branchManagerChannel() ||
    undefined
  );
}

/// The IST calendar date, which is the one the clinic means by "yesterday's backup".
/// A UTC-named object taken at 02:00 IST would carry the previous day's date.
export function istParts(now = new Date()): { date: string; weekday: number; dayOfMonth: number } {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return {
    date: ist.toISOString().slice(0, 10),
    weekday: ist.getUTCDay(),
    dayOfMonth: ist.getUTCDate(),
  };
}

/// Which tiers today's dump belongs to. Sunday is the week's copy; the 1st is the
/// month's. Both are also that day's daily copy — the same object, referenced twice.
export function tiersFor(now = new Date()): Tier[] {
  const { weekday, dayOfMonth } = istParts(now);
  const tiers: Tier[] = ["daily"];
  if (weekday === 0) tiers.push("weekly");
  if (dayOfMonth === 1) tiers.push("monthly");
  return tiers;
}

function objectKey(cfg: StorageConfig, tier: Tier, date: string, mode: DumpMode, encrypted: boolean): string {
  // pg_dump's custom format is a pg_restore archive; the portable one is gzipped
  // NDJSON. The extension is what tells a restore which it is holding.
  const ext = mode === "pg_dump" ? "dump" : "ndjson.gz";
  return `${cfg.prefix}/${tier}/${date}.${ext}${encrypted ? ".enc" : ""}`;
}

/// Delete everything past the retention count for one tier. Keys are date-prefixed,
/// so lexicographic order is chronological and the newest N are the tail.
async function prune(cfg: StorageConfig, tier: Tier): Promise<string[]> {
  const objects = await listObjects(cfg, `${cfg.prefix}/${tier}/`);
  const sorted = objects.map((o) => o.key).sort();
  const excess = sorted.slice(0, Math.max(0, sorted.length - keep(tier)));
  if (excess.length) await deleteObjects(cfg, excess);
  return excess;
}

/// Take the backup. Safe to call when nothing is configured — it says so and does
/// nothing, which is what keeps `npm run dev` from needing a bucket.
export async function runBackup(now = new Date()): Promise<BackupResult> {
  const startedAt = Date.now();
  const secondsSince = () => Math.round((Date.now() - startedAt) / 1000);
  const cfg = storageConfig();
  if (!cfg) {
    logger.info("Backup: no BACKUP_S3_* configuration — skipping");
    return { ok: false, tiers: [], pruned: [], error: "not configured", seconds: 0 };
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return { ok: false, tiers: [], pruned: [], error: "DATABASE_URL is unset", seconds: 0 };
  }

  const { date } = istParts(now);
  const tiers = tiersFor(now);
  let mode: DumpMode = "portable";

  try {
    const chosen = await chooseMode();
    mode = chosen.mode;
    if (mode === "portable") logger.warn(`Backup: using the portable dump — ${chosen.reason}`);

    const key = encryptionKey();
    const encrypted = key !== null;
    const dailyKey = objectKey(cfg, "daily", date, mode, encrypted);

    // pg_dump's custom format compresses itself; the portable dump doesn't, so it is
    // gzipped here. Encryption, when on, wraps whichever came out.
    const raw = mode === "pg_dump" ? pgDumpStream(databaseUrl) : gzip(portableDumpStream());
    const body = key ? encryptStream(raw, key) : raw;

    const sent = await putStream(cfg, dailyKey, body);

    // Trust the read, not the write: an upload can report success and leave an object
    // that is empty or truncated, and a backup nobody reads back is a guess.
    const stored = await headObject(cfg, dailyKey);
    if (stored === null) throw new Error(`uploaded ${dailyKey} but could not read it back`);
    if (stored < 1024) throw new Error(`${dailyKey} is only ${stored} bytes — the dump is empty`);
    if (stored !== sent) throw new Error(`sent ${sent} bytes to ${dailyKey} but it holds ${stored}`);

    for (const tier of tiers.filter((t) => t !== "daily")) {
      await copyObject(cfg, dailyKey, objectKey(cfg, tier, date, mode, encrypted));
    }

    const pruned: string[] = [];
    for (const tier of tiers) pruned.push(...(await prune(cfg, tier)));

    const result: BackupResult = {
      ok: true,
      key: dailyKey,
      bytes: stored,
      mode,
      encrypted,
      tiers,
      pruned,
      seconds: secondsSince(),
    };
    logger.info(
      `Backup: ${dailyKey} (${(stored / 1024 / 1024).toFixed(1)} MB, ${mode}${encrypted ? ", encrypted" : ""}) in ${result.seconds}s; tiers ${tiers.join("+")}; pruned ${pruned.length}`,
    );
    await report(result, chosen.reason);
    return result;
  } catch (err) {
    const result: BackupResult = {
      ok: false,
      mode,
      tiers,
      pruned: [],
      error: String(err instanceof Error ? err.message : err).slice(0, 400),
      seconds: secondsSince(),
    };
    logger.error(`Backup FAILED: ${result.error}`);
    await report(result, "");
    return result;
  }
}

async function report(result: BackupResult, modeReason: string): Promise<void> {
  const channel = alertChannel();
  if (!channel) return;

  if (!result.ok) {
    await sendSlack({
      channel,
      text:
        `🚨 *Database backup FAILED* — ${result.error}\n` +
        `No copy was taken for today. Every hour this stays broken is an hour of ` +
        `patient records with nothing behind them.`,
    });
    return;
  }

  // A working backup shouldn't post daily — that is how people learn to scroll past
  // it. The exceptions are worth saying out loud every time.
  const notes: string[] = [];
  if (result.mode === "portable") {
    notes.push(`⚠️ ran the *portable* dump, not pg_dump — ${modeReason}`);
  }
  if (!result.encrypted) {
    notes.push("⚠️ stored *unencrypted* — set `BACKUP_ENCRYPTION_KEY` to change that");
  }
  if (!notes.length && !process.env.BACKUP_REPORT_SUCCESS) return;

  await sendSlack({
    channel,
    text:
      `💾 *Database backup* — ${result.key} · ${((result.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB · ` +
      `${result.seconds}s · ${result.tiers.join(" + ")}` +
      (result.pruned.length ? ` · pruned ${result.pruned.length}` : "") +
      (notes.length ? `\n${notes.join("\n")}` : ""),
  });
}

let queue: Queue | null = null;
export function getBackupQueue(connection: ConnectionOptions): Queue {
  if (!queue) queue = new Queue(BACKUP_QUEUE, { connection });
  return queue;
}

/// Register the once-a-day repeatable job. BullMQ keeps the schedule in Redis, so it
/// survives restarts and only fires once even with the worker redeployed mid-day.
export async function scheduleBackup(connection: ConnectionOptions): Promise<void> {
  if (!isBackupConfigured()) {
    logger.info("Backup: not scheduling — BACKUP_S3_* is unset");
    return;
  }
  const hour = backupHour();
  await getBackupQueue(connection).add(
    BACKUP_JOB,
    {},
    {
      repeat: { pattern: `0 ${hour} * * *`, tz: "Asia/Kolkata" },
      jobId: "database-backup-cron",
      removeOnComplete: 30,
      removeOnFail: 30,
    },
  );
  logger.info(
    `Database backup scheduled for ${String(hour).padStart(2, "0")}:00 IST ` +
      `(keep ${keep("daily")} daily / ${keep("weekly")} weekly / ${keep("monthly")} monthly)`,
  );
}
