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
import { deleteRecording } from "@/lib/providers/recordings";
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
  let failed = 0; // recordings the provider would not delete — audio still out there

  // Loop batches until no call older than the cutoff still holds a recording/transcript.
  for (;;) {
    const calls = await prisma.call.findMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [{ recordingUrl: { not: null } }, { transcript: { not: null } }],
      },
      select: { id: true, recordingUrl: true, provider: true },
      take: BATCH,
    });
    if (calls.length === 0) break;
    scanned += calls.length;

    for (const c of calls) {
      // The row is cleared either way — leaving it would make this loop re-select the same
      // batch forever. But a failed delete means the audio is STILL THERE on the provider
      // while the CRM has stopped pointing at it, so it is logged with everything needed to
      // find it by hand. Silence here would look identical to a successful erasure.
      if (c.recordingUrl) {
        const gone = await deleteRecording(c.recordingUrl, c.provider);
        if (!gone) {
          failed++;
          logger.error(
            `Retention: FAILED to erase the recording for call ${c.id} at ${c.provider} ` +
              `(${c.recordingUrl}). The audio still exists and must be deleted by hand.`,
          );
        }
      }
      await prisma.call.update({
        where: { id: c.id },
        data: { recordingUrl: null, transcript: null },
      });
      purged++;
    }
    if (calls.length < BATCH) break;
  }

  if (purged > 0) {
    logger.info(
      `Retention purge: redacted ${purged} call(s) older than ${months} month(s)` +
        (failed > 0 ? ` — ${failed} recording(s) COULD NOT be erased at the provider` : ""),
    );
    // `failed` rides in the audit entry too: the CRM's own record of an erasure should say
    // whether the audio actually went, not merely that we stopped pointing at it.
    await writeAudit({
      action: "data.retention.purge", entityType: "call",
      newValue: String(purged), reason: `Redacted recordings/transcripts older than ${months} months`,
      meta: { months, cutoff: cutoff.toISOString(), purged, failedDeletes: failed },
    }).catch((err) => logger.error(`Retention purge audit failed: ${String(err)}`));
  }

  return { enabled: true, scanned, purged };
}
