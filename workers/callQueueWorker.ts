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
import {
  HANDOVER_SLA_QUEUE,
  runHandoverSlaCheck,
  type HandoverSlaJob,
} from "@/lib/handoverSla";
import { runStageSlaScan } from "@/lib/stageSla";
import { DIGEST_QUEUE, scheduleDailyDigest, sendDailyDigest } from "@/lib/digest";
import { monitorSystemHealth } from "@/lib/healthMonitor";
import { prisma } from "@/lib/prisma";
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

    // Opt-out gate (§3.1.10): never call a lead who opted out / said not interested.
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { optedOut: true } });
    if (lead?.optedOut) {
      logger.info(`Lead ${leadId} opted out — suppressing scheduled call (attempt ${attempt})`);
      return { suppressed: true, leadId, attempt };
    }

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

// Handover SLA worker — fires HANDOVER_SLA_HOURS after a lead is handed to a rep.
// If the lead is still unattended, it escalates to the counsellor on Slack (§3.1).
const slaWorker = new Worker<HandoverSlaJob>(
  HANDOVER_SLA_QUEUE,
  async (job) => runHandoverSlaCheck(job.data),
  { connection: bullConnection, concurrency: CONCURRENCY },
);
slaWorker.on("completed", (job, result) =>
  logger.info(`SLA check ${job.id} (lead ${job.data.leadId}): ${JSON.stringify(result)}`),
);
slaWorker.on("failed", (job, err) => logger.error(`SLA check ${job?.id} failed: ${err.message}`));
logger.info(`Handover SLA worker started on queue "${HANDOVER_SLA_QUEUE}"`);

// ElevenLabs health/credit monitor — probe now, then on an interval. Alerts the
// sales team on Slack if the API is down, the key is dead, or credits run low.
const runMonitor = () =>
  monitorElevenLabs().catch((err) => logger.error(`ElevenLabs monitor error: ${String(err)}`));
runMonitor();
setInterval(runMonitor, MONITOR_INTERVAL_MS);
logger.info(`ElevenLabs monitor active (every ${MONITOR_INTERVAL_MS / 60_000} min)`);

// Stuck-in-stage SLA scan — flag leads that haven't advanced stage past the SLA
// and alert the counsellor (§3.1). Scan now, then on an interval (default 6h).
const STAGE_SLA_SCAN_MS = Number(process.env.STAGE_SLA_SCAN_HOURS ?? 6) * 60 * 60_000;
const runStageScan = () =>
  runStageSlaScan().catch((err) => logger.error(`Stage-SLA scan error: ${String(err)}`));
runStageScan();
setInterval(runStageScan, STAGE_SLA_SCAN_MS);
logger.info(`Stage-SLA scan active (every ${STAGE_SLA_SCAN_MS / 3_600_000} h)`);

// System health monitor — probe Postgres / Redis / web / external APIs and alert
// the CRM admin + branch manager on Slack the moment something goes down (§3.1).
const HEALTH_MONITOR_MS = Number(process.env.HEALTH_MONITOR_MINUTES ?? 5) * 60_000;
const runHealth = () =>
  monitorSystemHealth().catch((err) => logger.error(`Health monitor error: ${String(err)}`));
runHealth();
setInterval(runHealth, HEALTH_MONITOR_MS);
logger.info(`System health monitor active (every ${HEALTH_MONITOR_MS / 60_000} min)`);

// Branch Manager daily digest — a repeatable (cron) job fires once a day at
// DIGEST_HOUR_IST; this worker registers it and processes it (§3.1).
const digestWorker = new Worker(
  DIGEST_QUEUE,
  async () => sendDailyDigest(),
  { connection: bullConnection, concurrency: 1 },
);
digestWorker.on("failed", (job, err) => logger.error(`Digest job ${job?.id} failed: ${err.message}`));
scheduleDailyDigest().catch((err) => logger.error(`Failed to schedule daily digest: ${String(err)}`));
