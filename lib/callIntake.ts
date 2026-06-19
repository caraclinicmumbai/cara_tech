// Central call-recording pipeline. Both the n8n Agent 2 write-back (/api/calls)
// and the direct ElevenLabs post-call webhook (/api/webhooks/call-completed)
// funnel through recordCall(): persist the Call, update the Lead's status, and —
// when a call goes UNANSWERED — schedule the next retry attempt via BullMQ until
// the attempt cap is reached (§3.1.2 call attempt logic).
import type { Call } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { statusFromOutcome } from "@/lib/contracts";
import { scheduleCallAttempt, retryDelaysDays, DAY_MS } from "@/lib/queue";
import { logger } from "@/lib/logger";

// Outcomes that END the attempt ladder — the lead was reached and a decision
// was logged. Anything else (no_answer, or no outcome at all) is "unanswered".
const RESOLVED_OUTCOMES = ["confirmed", "rescheduled", "not_interested"];

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

  // This call's attempt number = total calls recorded for the lead (incl. this one).
  const attemptNumber = await prisma.call.count({ where: { leadId: lead.id } });
  const unanswered = !RESOLVED_OUTCOMES.includes(input.outcome ?? "");

  let status = statusFromOutcome(input.outcome);

  if (unanswered) {
    const delays = retryDelaysDays(); // e.g. [1, 5]
    const maxAttempts = delays.length + 1; // + the immediate intake call
    if (attemptNumber < maxAttempts) {
      const delayDays = delays[attemptNumber - 1]!; // delay from attempt N to N+1
      const nextAttempt = attemptNumber + 1;
      try {
        await scheduleCallAttempt(
          {
            leadId: lead.id,
            phone: lead.phone,
            attempt: nextAttempt,
            callType: "reconfirmation",
            context: input.transcript?.slice(0, 1000),
          },
          delayDays * DAY_MS,
        );
        logger.info(
          `Lead ${lead.id} unanswered (attempt ${attemptNumber}) — scheduled attempt ${nextAttempt} in ${delayDays}d`,
        );
      } catch (err) {
        logger.error(`Failed to schedule attempt ${nextAttempt} for lead ${lead.id}: ${String(err)}`);
      }
    } else {
      // Exhausted all attempts with no answer — mark unreachable (fallback queue).
      status = "unreachable";
      logger.info(`Lead ${lead.id} unreachable after ${attemptNumber} attempts`);
    }
  }

  await prisma.lead.update({ where: { id: lead.id }, data: { status } });

  logger.info(
    `Recorded ${input.callType} call ${call.id} for lead ${lead.id} (attempt ${attemptNumber}, status=${status})`,
  );
  return { ok: true, call };
}
