// Central call-recording pipeline. Both the n8n Agent 2 write-back (/api/calls)
// and the direct ElevenLabs post-call webhook (/api/webhooks/call-completed)
// funnel through recordCall(): persist the Call, update the Lead's status, and —
// after an INITIAL call — schedule the re-confirmation via BullMQ.
import type { Call } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { statusFromOutcome } from "@/lib/contracts";
import { scheduleReconfirmation } from "@/lib/queue";
import { logger } from "@/lib/logger";

export type RecordCallInput = {
  leadId: string;
  callType: "initial" | "reconfirmation";
  elevenlabsId?: string;
  transcript?: string;
  outcome?: string;
  sentiment?: string;
  duration?: number;
};

export type RecordCallResult =
  | { ok: true; call: Call }
  | { ok: false; reason: "lead_not_found" };

export async function recordCall(input: RecordCallInput): Promise<RecordCallResult> {
  const lead = await prisma.lead.findUnique({ where: { id: input.leadId } });
  if (!lead) return { ok: false, reason: "lead_not_found" };

  const call = await prisma.call.create({
    data: {
      leadId: input.leadId,
      callType: input.callType,
      elevenlabsId: input.elevenlabsId,
      transcript: input.transcript,
      outcome: input.outcome,
      sentiment: input.sentiment,
      duration: input.duration,
    },
  });

  const status = statusFromOutcome(input.outcome);
  await prisma.lead.update({ where: { id: lead.id }, data: { status } });

  // After the FIRST call, schedule the re-confirmation (unless already confirmed/lost).
  if (input.callType === "initial" && !["confirmed", "lost"].includes(status)) {
    try {
      await scheduleReconfirmation({
        leadId: lead.id,
        phone: lead.phone,
        context: input.transcript?.slice(0, 1000),
      });
      logger.info(`Scheduled re-confirmation for lead ${lead.id}`);
    } catch (err) {
      logger.error(`Failed to schedule re-confirmation for lead ${lead.id}: ${String(err)}`);
    }
  }

  logger.info(`Recorded ${input.callType} call ${call.id} for lead ${lead.id} (status=${status})`);
  return { ok: true, call };
}
