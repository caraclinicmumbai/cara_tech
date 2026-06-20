// Central call-recording pipeline. Both the n8n Agent 2 write-back (/api/calls)
// and the direct ElevenLabs post-call webhook (/api/webhooks/call-completed)
// funnel through recordCall(): persist the Call, update the Lead's status, and —
// when a call goes UNANSWERED — schedule the next retry attempt via BullMQ until
// the attempt cap is reached (§3.1.2 call attempt logic).
import type { Call } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { statusFromOutcome } from "@/lib/contracts";
import { scheduleCallAttempt, cancelScheduledCalls, retryDelaysDays, DAY_MS } from "@/lib/queue";
import { nextEveningCallback } from "@/lib/callWindow";
import { logger } from "@/lib/logger";

// Outcomes that END the attempt ladder — the lead was reached and a decision
// was logged. Anything else (no_answer, or no outcome at all) is "unanswered".
const RESOLVED_OUTCOMES = ["confirmed", "rescheduled", "not_interested"];

function parseCallbackAt(v?: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type RecordCallInput = {
  leadId: string;
  callType: "initial" | "reconfirmation";
  elevenlabsId?: string;
  transcript?: string;
  outcome?: string;
  sentiment?: string;
  duration?: number;
  /// ISO datetime the lead asked to be called back (§3.1.2).
  callbackAt?: string;
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
  const callbackAt = parseCallbackAt(input.callbackAt);
  const unanswered = !RESOLVED_OUTCOMES.includes(input.outcome ?? "");

  let status = statusFromOutcome(input.outcome);
  const leadData: {
    status: string;
    callbackAt?: Date;
    optedOut?: boolean;
    optedOutAt?: Date;
    optedOutReason?: string;
  } = { status };

  if (input.outcome === "not_interested") {
    // Hard opt-out (§3.1.10): the lead said they're not interested. Mark them,
    // suppress ALL further outreach, and cancel any pending retries/callbacks.
    status = "not_interested";
    leadData.status = "not_interested";
    leadData.optedOut = true;
    leadData.optedOutAt = new Date();
    leadData.optedOutReason = "Said not interested on AI call";
    const canceled = await cancelScheduledCalls(lead.id);
    logger.info(`Lead ${lead.id} opted out (not interested) — suppressed all outreach, canceled ${canceled} pending`);
  } else if (input.outcome === "rescheduled" || callbackAt) {
    // Lead asked to be called back (§3.1.2). If they named a time, honour it;
    // a vague "call me back" with no time defaults to the evening callback hour
    // (7 PM IST). Either way: cancel the auto-retry ladder and queue a single
    // call at the target — DND-adjusted, so out-of-hours requests still comply.
    const target = callbackAt ?? nextEveningCallback();
    status = "rescheduled";
    leadData.status = "rescheduled";
    leadData.callbackAt = target;
    const canceled = await cancelScheduledCalls(lead.id);
    try {
      await scheduleCallAttempt(
        {
          leadId: lead.id,
          phone: lead.phone,
          attempt: attemptNumber + 1,
          callType: "reconfirmation",
          context: input.transcript?.slice(0, 1000),
        },
        target.getTime() - Date.now(),
      );
      logger.info(
        `Lead ${lead.id} callback ${callbackAt ? "at requested time" : "(no time → evening 7 PM default)"} ${target.toISOString()} — canceled ${canceled} pending`,
      );
    } catch (err) {
      logger.error(`Failed to schedule callback for lead ${lead.id}: ${String(err)}`);
    }
  } else if (unanswered) {
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
      leadData.status = "unreachable";
      logger.info(`Lead ${lead.id} unreachable after ${attemptNumber} attempts`);
    }
  }

  await prisma.lead.update({ where: { id: lead.id }, data: leadData });

  logger.info(
    `Recorded ${input.callType} call ${call.id} for lead ${lead.id} (attempt ${attemptNumber}, status=${status})`,
  );
  return { ok: true, call };
}
