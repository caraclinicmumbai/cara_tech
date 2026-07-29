// Data-retention purge (§compliance C3 / DPDP data minimisation). Call recordings
// and transcripts are the most sensitive data we hold (a patient's health-context
// conversation), and today they're kept forever. This redacts them once they age
// past a retention window: delete the audio from Twilio AND null the recordingUrl +
// transcript on the Call, keeping the non-PII shape (outcome, CQS number, duration)
// for aggregate reporting.
//
// OFF by default: with DATA_RETENTION_MONTHS unset the purge is a no-op, so nothing
// is destroyed until the clinic sets a window. The worker calls runRetentionPurge()
// on a daily interval (see workers/callQueueWorker.ts).
import { prisma } from "@/lib/prisma";
import { deleteTwilioRecording } from "@/lib/providers/twilio";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/// The configured retention window in months, or null when disabled/invalid.
export function retentionMonths(): number | null {
  const raw = process.env.DATA_RETENTION_MONTHS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/// Cutoff date: calls created before this are past the retention window.
export function retentionCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

export type RetentionResult = { enabled: boolean; scanned: number; purged: number };

/// Redact recordings + transcripts on calls older than the retention window.
/// Best-effort per call: a provider-delete failure still nulls our columns (we don't
/// want to keep re-serving a transcript because Twilio was briefly unreachable).
/// Batched to avoid loading the whole table at once.
export async function runRetentionPurge(now: Date = new Date()): Promise<RetentionResult> {
  const months = retentionMonths();
  if (!months) return { enabled: false, scanned: 0, purged: 0 };

  const cutoff = retentionCutoff(now, months);
  const BATCH = 200;
  let scanned = 0;
  let purged = 0;

  // Loop batches until no call older than the cutoff still holds a recording/transcript.
  for (;;) {
    const calls = await prisma.call.findMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [{ recordingUrl: { not: null } }, { transcript: { not: null } }],
      },
      select: { id: true, recordingUrl: true },
      take: BATCH,
    });
    if (calls.length === 0) break;
    scanned += calls.length;

    for (const c of calls) {
      if (c.recordingUrl) await deleteTwilioRecording(c.recordingUrl);
      await prisma.call.update({
        where: { id: c.id },
        data: { recordingUrl: null, transcript: null },
      });
      purged++;
    }
    if (calls.length < BATCH) break;
  }

  if (purged > 0) {
    logger.info(`Retention purge: redacted ${purged} call(s) older than ${months} month(s)`);
    await writeAudit({
      action: "data.retention.purge", entityType: "call",
      newValue: String(purged), reason: `Redacted recordings/transcripts older than ${months} months`,
      meta: { months, cutoff: cutoff.toISOString(), purged },
    }).catch((err) => logger.error(`Retention purge audit failed: ${String(err)}`));
  }

  return { enabled: true, scanned, purged };
}
