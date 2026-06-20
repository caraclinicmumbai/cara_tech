// BullMQ worker — processes delayed call-attempt jobs. (Guide §2.4, §5)
// Run standalone (PM2 / Railway service): `npm run worker`.
// On a fired job it re-triggers n8n Agent 1 with the prior-call context so
// ElevenLabs places the next personalised retry call.
import "dotenv/config";
import { Worker } from "bullmq";
import {
  CALL_ATTEMPT_QUEUE,
  bullConnection,
  deferCallToWindow,
  type CallAttemptJob,
} from "@/lib/queue";
import { isWithinDnd } from "@/lib/callWindow";
import { triggerOutboundCall } from "@/lib/n8n";
import { monitorElevenLabs } from "@/lib/providers/elevenlabsHealth";
import { logger } from "@/lib/logger";

// Caps how many calls we initiate in parallel — the morning backlog of held
// leads drains FIFO at this rate (§3.1.2 concurrent capacity). Default 10.
const CONCURRENCY = Number(process.env.AI_MAX_CONCURRENT_CALLS ?? 10);

// How often to probe ElevenLabs health/credits and alert Slack on problems.
const MONITOR_INTERVAL_MS = Number(process.env.ELEVENLABS_MONITOR_MINUTES ?? 15) * 60_000;

const worker = new Worker<CallAttemptJob>(
  CALL_ATTEMPT_QUEUE,
  async (job) => {
    const { leadId, phone, context, attempt, callType } = job.data;

    // Safety net: if this fires inside the DND window (e.g. worker was down past
    // the window opening), defer to the next permitted time instead of calling.
    if (isWithinDnd()) {
      await deferCallToWindow(job.data, Date.now());
      logger.info(`Attempt ${attempt} for lead ${leadId} hit DND window — deferred to next opening`);
      return { deferred: true, leadId, attempt };
    }

    logger.info(`Call attempt ${attempt} firing for lead ${leadId}`);
    await triggerOutboundCall({
      leadId,
      phone,
      name: "", // n8n re-fetches lead details by leadId if needed
      callType,
      context,
    });

    return { triggered: true, leadId, attempt };
  },
  { connection: bullConnection, concurrency: CONCURRENCY },
);

worker.on("completed", (job) =>
  logger.info(`Job ${job.id} completed (lead ${job.data.leadId}, attempt ${job.data.attempt})`),
);
worker.on("failed", (job, err) =>
  logger.error(`Job ${job?.id} failed: ${err.message}`),
);

logger.info(
  `Call-attempt worker started on queue "${CALL_ATTEMPT_QUEUE}" (concurrency ${CONCURRENCY})`,
);

// ElevenLabs health/credit monitor — probe now, then on an interval. Alerts the
// sales team on Slack if the API is down, the key is dead, or credits run low.
const runMonitor = () =>
  monitorElevenLabs().catch((err) => logger.error(`ElevenLabs monitor error: ${String(err)}`));
runMonitor();
setInterval(runMonitor, MONITOR_INTERVAL_MS);
logger.info(`ElevenLabs monitor active (every ${MONITOR_INTERVAL_MS / 60_000} min)`);
