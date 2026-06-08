// BullMQ queue definitions. (Guide §2.4 / §5: lib/queue.ts)
// This queue owns the re-confirmation timer: a delayed job is added when an
// initial call completes, and fires after RECONFIRMATION_DELAY_DAYS.
import { Queue, type ConnectionOptions } from "bullmq";
import { redis } from "@/lib/redis";

// BullMQ bundles its own nested ioredis, so a top-level ioredis instance is
// structurally compatible at runtime but not by type. Cast once, here.
export const bullConnection = redis as unknown as ConnectionOptions;

export const RECONFIRMATION_QUEUE = "reconfirmation-calls";

/// Payload carried by a re-confirmation job.
export type ReconfirmationJob = {
  leadId: string;
  phone: string;
  /// Summary/context from the first call, passed to ElevenLabs for personalisation.
  context?: string;
};

// Lazily instantiated so importing this module (e.g. during `next build`)
// doesn't open a Redis connection. Created on first actual use.
let _callQueue: Queue<ReconfirmationJob> | undefined;

export function getCallQueue(): Queue<ReconfirmationJob> {
  if (!_callQueue) {
    _callQueue = new Queue<ReconfirmationJob>(RECONFIRMATION_QUEUE, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return _callQueue;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/// Schedule a re-confirmation call N days from now (default from env).
export async function scheduleReconfirmation(
  job: ReconfirmationJob,
  days = Number(process.env.RECONFIRMATION_DELAY_DAYS ?? 3),
) {
  return getCallQueue().add("triggerReconfirmation", job, {
    delay: days * DAY_MS,
    jobId: `reconfirm-${job.leadId}`, // idempotent: one pending job per lead (no ':' — BullMQ forbids it)
  });
}
