// BullMQ worker — processes delayed call-attempt jobs. (Guide §2.4, §5)
// Run standalone (PM2 / Railway service): `npm run worker`.
// On a fired job it re-triggers n8n Agent 1 with the prior-call context so
// ElevenLabs places the next personalised retry call.
import "dotenv/config";
import { Worker } from "bullmq";
import { CALL_ATTEMPT_QUEUE, bullConnection, type CallAttemptJob } from "@/lib/queue";
import { triggerOutboundCall } from "@/lib/n8n";
import { logger } from "@/lib/logger";

const worker = new Worker<CallAttemptJob>(
  CALL_ATTEMPT_QUEUE,
  async (job) => {
    const { leadId, phone, context, attempt } = job.data;
    logger.info(`Call attempt ${attempt} firing for lead ${leadId}`);

    await triggerOutboundCall({
      leadId,
      phone,
      name: "", // n8n re-fetches lead details by leadId if needed
      callType: "reconfirmation",
      context,
    });

    return { triggered: true, leadId, attempt };
  },
  { connection: bullConnection, concurrency: 5 },
);

worker.on("completed", (job) =>
  logger.info(`Job ${job.id} completed (lead ${job.data.leadId}, attempt ${job.data.attempt})`),
);
worker.on("failed", (job, err) =>
  logger.error(`Job ${job?.id} failed: ${err.message}`),
);

logger.info(`Call-attempt worker started on queue "${CALL_ATTEMPT_QUEUE}"`);
