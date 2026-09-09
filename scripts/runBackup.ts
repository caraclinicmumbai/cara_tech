// Take a backup right now (§backups) — `npm run backup:now`.
//
// The same code path the worker runs on its schedule, so a successful run here is
// evidence the scheduled one will work: same dump mode, same bucket, same retention.
// Use it after configuring the bucket, and before trusting any of it.
import "dotenv/config";
import { runBackup } from "@/lib/backup";
import { chooseMode } from "@/lib/backup/dump";
import { isBackupConfigured } from "@/lib/backup/storage";
import { isEncryptionEnabled } from "@/lib/backup/crypto";

async function main() {
  if (!isBackupConfigured()) {
    console.error("❌ BACKUP_S3_* is not configured — nothing to back up to.");
    process.exit(1);
  }
  const { mode, reason } = await chooseMode();
  console.log(`Mode:       ${mode} (${reason})`);
  console.log(`Encryption: ${isEncryptionEnabled() ? "on" : "OFF — set BACKUP_ENCRYPTION_KEY"}`);
  console.log("Running …");

  const result = await runBackup();
  if (!result.ok) {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
  console.log(
    `✅ ${result.key} — ${((result.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB in ${result.seconds}s\n` +
      `   tiers:  ${result.tiers.join(" + ")}\n` +
      `   pruned: ${result.pruned.length ? result.pruned.join(", ") : "nothing"}\n\n` +
      `Now prove it restores:  npm run backup:verify -- ${result.key}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
