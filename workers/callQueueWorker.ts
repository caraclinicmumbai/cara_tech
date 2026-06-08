// BullMQ worker — processes delayed re-confirmation jobs. (Guide §2.4, §5)
// Run standalone (PM2 in prod): `npm run worker`.
// On a fired job it re-triggers n8n Agent 1 with the prior-call context so
// ElevenLabs places a personalised second call.
import "dotenv/config";
import { Worker } from "bullmq";
import { RECONFIRMATION_QUEUE, bullConnection, type ReconfirmationJob } from "@/lib/queue";
import { triggerOutboundCall } from "@/lib/n8n";
import { logger } from "@/lib/logger";

const worker = new Worker<ReconfirmationJob>(
  RECONFIRMATION_QUEUE,
  async (job) => {
    const { leadId, phone, context } = job.data;
    logger.info(`Re-confirmation job firing for lead ${leadId}`);

    await triggerOutboundCall({
      leadId,
      phone,
      name: "", // n8n re-fetches lead details by leadId if needed
      callType: "reconfirmation",
      context,
    });

    return { triggered: true, leadId };
  },
  { connection: bullConnection, concurrency: 5 },
);

worker.on("completed", (job) =>
  logger.info(`Job ${job.id} completed (lead ${job.data.leadId})`),
);
worker.on("failed", (job, err) =>
  logger.error(`Job ${job?.id} failed: ${err.message}`),
);

logger.info(`Re-confirmation worker started on queue "${RECONFIRMATION_QUEUE}"`);
