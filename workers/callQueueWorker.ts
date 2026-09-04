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
  aiCallsPaused,
  type CallAttemptJob,
} from "@/lib/queue";
import { isWithinDnd } from "@/lib/callWindow";
import { placeOutboundCall } from "@/lib/providers/elevenlabs";
import { monitorElevenLabs } from "@/lib/providers/elevenlabsHealth";
import {
  HANDOVER_SLA_QUEUE,
  runHandoverSlaCheck,
  type HandoverSlaJob,
} from "@/lib/handoverSla";
import { runStageSlaScan } from "@/lib/stageSla";
import { DIGEST_QUEUE, scheduleDailyDigest, sendDailyDigest } from "@/lib/digest";
import { monitorSystemHealth } from "@/lib/healthMonitor";
import { sweepIdle, IDLE_MINUTES } from "@/lib/presence";
import { runFollowUpReminders } from "@/lib/followUpReminders";
import { runCampaignTick } from "@/lib/campaigns/engine";
import { runWinBackSweep } from "@/lib/campaigns/winback";
import { runRetentionPurge, retentionMonths } from "@/lib/dataRetention";
import { runCheckInTick, checkInsEnabled } from "@/lib/postSales/checkins";
import { runPostSalesSlaScan, reconcileMissingJourneys } from "@/lib/postSales/sla";
import { campaignsEnabled } from "@/lib/campaigns/types";
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

    // Global kill-switch (§3.1): AI_CALLS_PAUSED halts all automated calls, including
    // already-queued retries/callbacks firing now. Rep click-to-call is unaffected.
    if (aiCallsPaused()) {
      logger.info(`AI calls paused (AI_CALLS_PAUSED) — skipping scheduled call for lead ${leadId} (attempt ${attempt})`);
      return { paused: true, leadId, attempt };
    }

    // Opt-out gate (§3.1.10): never call a lead who opted out / said not interested.
    // Also skip a lead that was moved to trash (soft-deleted) after this was queued.
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { optedOut: true, name: true, interest: true, deletedAt: true },
    });
    if (lead?.deletedAt) {
      logger.info(`Lead ${leadId} deleted — suppressing scheduled call (attempt ${attempt})`);
      return { suppressed: true, leadId, attempt };
    }
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
    await placeOutboundCall({
      leadId,
      phone,
      name: lead?.name ?? "",
      interest: lead?.interest ?? undefined,
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

// Counsellor presence sweep (§presence) — once a minute, set any counsellor Offline
// who hasn't sent a heartbeat in PRESENCE_IDLE_MINUTES during working hours and tell
// their manager. Keeps "leads going to people who went home" from happening.
const PRESENCE_SWEEP_MS = 60_000;
const runPresenceSweep = () =>
  sweepIdle().catch((err) => logger.error(`Presence sweep error: ${String(err)}`));
runPresenceSweep();
setInterval(runPresenceSweep, PRESENCE_SWEEP_MS);
logger.info(`Presence idle-sweep active (every ${PRESENCE_SWEEP_MS / 1000}s, threshold ${IDLE_MINUTES}m)`);

// Follow-up reminders (§follow-up reminders) — a date on a lead is a promise to call
// somebody back, and until now nothing told the counsellor the moment arrived. Raises
// the in-app bell (works with nothing configured) and Slack on top when it's wired up.
// Needs no enabling flag: a reminder for a date a human typed is never unwanted.
const FOLLOWUP_REMINDER_MS = Number(process.env.FOLLOWUP_REMINDER_MINUTES ?? 5) * 60_000;
const runFollowUpSweep = () =>
  runFollowUpReminders().catch((err) => logger.error(`Follow-up reminder sweep error: ${String(err)}`));
runFollowUpSweep();
setInterval(runFollowUpSweep, FOLLOWUP_REMINDER_MS);
logger.info(`Follow-up reminders active (every ${FOLLOWUP_REMINDER_MS / 60_000} min)`);

// Follow-up campaign engine (§follow-up) — advance every enrollment whose next step is
// due: run the guardrail gate, send the step, schedule the next (or complete + mark Lost).
// Deferrals (ceiling / quiet hours) just push nextRunAt forward. A DB-polling interval
// (like the presence/stage sweeps) rather than per-message jobs, so the guardrails
// re-evaluate on every attempt. Gated by CAMPAIGNS_ENABLED (off = the tick is a no-op).
const CAMPAIGN_TICK_MS = Number(process.env.CAMPAIGN_TICK_MINUTES ?? 15) * 60_000;
const runCampaigns = () =>
  runCampaignTick().catch((err) => logger.error(`Campaign tick error: ${String(err)}`));
runCampaigns();
setInterval(runCampaigns, CAMPAIGN_TICK_MS);
logger.info(
  `Follow-up campaign engine ${campaignsEnabled() ? "active" : "idle (CAMPAIGNS_ENABLED off)"} (tick every ${CAMPAIGN_TICK_MS / 60_000} min)`,
);

// Win-Back sweep (§follow-up) — once every WINBACK_SWEEP_HOURS (default 12), enrol leads
// that have been Lost for 90+ days into the automatic Win-Back campaign (max 4/yr, consent-
// and opt-out-checked). Also gated by CAMPAIGNS_ENABLED (the sweep no-ops when off).
const WINBACK_SWEEP_MS = Number(process.env.WINBACK_SWEEP_HOURS ?? 12) * 60 * 60_000;
const runWinBack = () =>
  runWinBackSweep().catch((err) => logger.error(`Win-back sweep error: ${String(err)}`));
runWinBack();
setInterval(runWinBack, WINBACK_SWEEP_MS);
logger.info(`Win-back sweep active (every ${WINBACK_SWEEP_MS / 3_600_000} h)`);

// Post-sales care check-ins (§post-sales) — send every day 1/7/30/90 check-in that is
// due, coordinated so no patient gets two care messages on the same day across their
// journeys. A DB-polling tick like the campaign engine, so the clinical-consent and
// safety gates re-evaluate on every attempt. Gated by POSTSALES_CHECKINS_ENABLED (off =
// the tick is a no-op, schedules still build but nothing sends).
const CHECKIN_TICK_MS = Number(process.env.POSTSALES_CHECKIN_TICK_MINUTES ?? 15) * 60_000;
const runCheckIns = () =>
  runCheckInTick().catch((err) => logger.error(`Post-sales check-in tick error: ${String(err)}`));
runCheckIns();
setInterval(runCheckIns, CHECKIN_TICK_MS);
logger.info(
  `Post-sales check-ins ${checkInsEnabled() ? "active" : "idle (POSTSALES_CHECKINS_ENABLED off)"} (tick every ${CHECKIN_TICK_MS / 60_000} min)`,
);

// Post-sales stage SLA (§post-sales) — flag journeys past their per-treatment stage
// limit and alert the accountable consultant/doctor, once per stall. The same pass
// reconciles any converted quote that somehow has no journey, so "every converted
// patient is in the post-sales pipeline automatically" holds even if the conversion
// crashed between committing the quote and opening the journey.
const POSTSALES_SLA_MS = Number(process.env.POSTSALES_SLA_SCAN_HOURS ?? 6) * 60 * 60_000;
const runPostSalesSla = async () => {
  await reconcileMissingJourneys().catch((err) =>
    logger.error(`Post-sales journey reconcile error: ${String(err)}`),
  );
  await runPostSalesSlaScan().catch((err) => logger.error(`Post-sales SLA scan error: ${String(err)}`));
};
runPostSalesSla();
setInterval(runPostSalesSla, POSTSALES_SLA_MS);
logger.info(`Post-sales SLA scan active (every ${POSTSALES_SLA_MS / 3_600_000} h)`);

// Data-retention purge (§compliance C3) — once a day, redact recordings + transcripts
// on calls older than DATA_RETENTION_MONTHS. OFF unless that env is set (runRetentionPurge
// no-ops when unset), so nothing is destroyed until the clinic chooses a window.
const RETENTION_SCAN_MS = Number(process.env.RETENTION_SCAN_HOURS ?? 24) * 60 * 60_000;
const runRetention = () =>
  runRetentionPurge().catch((err) => logger.error(`Retention purge error: ${String(err)}`));
runRetention();
setInterval(runRetention, RETENTION_SCAN_MS);
logger.info(
  `Data-retention purge ${retentionMonths() ? `active (>${retentionMonths()}mo, scan every ${RETENTION_SCAN_MS / 3_600_000}h)` : "idle (DATA_RETENTION_MONTHS unset)"}`,
);

// Branch Manager daily digest — a repeatable (cron) job fires once a day at
// DIGEST_HOUR_IST; this worker registers it and processes it (§3.1).
const digestWorker = new Worker(
  DIGEST_QUEUE,
  async () => sendDailyDigest(),
  { connection: bullConnection, concurrency: 1 },
);
digestWorker.on("failed", (job, err) => logger.error(`Digest job ${job?.id} failed: ${err.message}`));
scheduleDailyDigest().catch((err) => logger.error(`Failed to schedule daily digest: ${String(err)}`));
