// BullMQ queue — drives the AI call ATTEMPT ladder. (Guide §2.4 / §5: lib/queue.ts)
// Attempt 1 is the immediate call placed at lead intake (T+0). On each
// *unanswered* result, recordCall() schedules a delayed follow-up job here:
// attempt 2 after RETRY_DELAYS_DAYS[0] days, attempt 3 after RETRY_DELAYS_DAYS[1],
// etc., capped at maxCallAttempts(). The worker consumes these and re-fires the call.
import { Queue, type ConnectionOptions } from "bullmq";
import { redis } from "@/lib/redis";
import { permittedDelayMs } from "@/lib/callWindow";

// BullMQ bundles its own nested ioredis, so a top-level ioredis instance is
// structurally compatible at runtime but not by type. Cast once, here.
export const bullConnection = redis as unknown as ConnectionOptions;

// Queue name kept stable ("reconfirmation-calls") across the rename so any
// existing worker/monitoring binding keeps working.
export const CALL_ATTEMPT_QUEUE = "reconfirmation-calls";

/// Payload carried by a delayed call-attempt job.
export type CallAttemptJob = {
  leadId: string;
  phone: string;
  /// 1-based attempt number this job will place (e.g. 2 = first retry).
  attempt: number;
  /// "initial" when this is a held first call (created during the DND window),
  /// "reconfirmation" for a follow-up retry attempt.
  callType: "initial" | "reconfirmation";
  /// Summary/context from the prior call, passed to ElevenLabs for personalisation.
  context?: string;
};

// Lazily instantiated so importing this module (e.g. during `next build`)
// doesn't open a Redis connection. Created on first actual use.
let _callQueue: Queue<CallAttemptJob> | undefined;

export function getCallQueue(): Queue<CallAttemptJob> {
  if (!_callQueue) {
    _callQueue = new Queue<CallAttemptJob>(CALL_ATTEMPT_QUEUE, {
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

export const DAY_MS = 24 * 60 * 60 * 1000;

/// Days to wait before each follow-up attempt, from RETRY_DELAYS_DAYS (default
/// "1,5"): attempt 2 after 1 day, attempt 3 after 5 days. The number of retries
/// is the list length; total attempts = that + 1 (attempt 1 is the intake call).
export function retryDelaysDays(): number[] {
  return (process.env.RETRY_DELAYS_DAYS ?? "1,5")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

/// Total permitted call attempts including the immediate intake call.
export function maxCallAttempts(): number {
  return retryDelaysDays().length + 1;
}

/// Enqueue a call attempt to fire `baseDelayMs` from now — but NEVER inside the
/// do-not-call window. If the target lands in DND it's pushed to the next
/// permitted opening (10:00 IST), where held leads drain in FIFO order capped by
/// the worker's concurrency. Idempotent per (lead, attempt): a duplicate webhook
/// can't double-book the same attempt.
export async function scheduleCallAttempt(job: CallAttemptJob, baseDelayMs = 0) {
  return getCallQueue().add("callAttempt", job, {
    delay: permittedDelayMs(new Date(), baseDelayMs),
    jobId: `attempt-${job.leadId}-${job.attempt}`,
  });
}

/// Defer a job that fired inside the DND window (e.g. worker was down past the
/// window) to the next permitted opening. Uniquely-suffixed jobId so it doesn't
/// collide with the still-completing original.
export async function deferCallToWindow(job: CallAttemptJob, nowMs: number) {
  return getCallQueue().add("callAttempt", job, {
    delay: permittedDelayMs(new Date(nowMs), 0),
    jobId: `attempt-${job.leadId}-${job.attempt}-dnd-${nowMs}`,
  });
}
