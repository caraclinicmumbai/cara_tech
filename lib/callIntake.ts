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
import { stageFromOutcome, advanceStage } from "@/lib/leadStages";
import { evaluateHandover, notifyHandover } from "@/lib/handover";
import { sendAutomatedTemplate, outreachTemplate, firstName, istTime } from "@/lib/outreach";
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
  /// What the lead asked for in the call → stored as the lead's tag (§3.1).
  tag?: string;
  /// AI→human handover signals (§3.1): explicit trigger keys + CQS + language.
  handoverReasons?: string[];
  cqs?: number;
  language?: string;
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
    stage?: string;
    tag?: string;
    needsHandover?: boolean;
    handoverReason?: string;
    handoverAt?: Date;
    handoverTriggers?: string[];
  } = { status };

  // AI→human handover (§3.1): did this call hit any trigger? Evaluated up front;
  // when it fires it takes over the routing (stop AI drip, alert sales) — except
  // an explicit opt-out ("not interested"), which still wins (nothing to hand off).
  const handover = evaluateHandover({
    reasons: input.handoverReasons,
    cqs: input.cqs,
    language: input.language,
  });

  // Pipeline stage: auto-advance FORWARD-ONLY from the call outcome so we never
  // regress a stage staff (or an earlier, further-along call) already set (§3.1).
  const nextStage = advanceStage(lead.stage, stageFromOutcome(input.outcome));
  if (nextStage) leadData.stage = nextStage;

  // Tag: what the lead asked for, as captured by the AI. Only overwrite when the
  // call actually carried one — an empty extraction shouldn't wipe a manual tag.
  const tag = input.tag?.trim();
  if (tag) leadData.tag = tag;

  // Automated WhatsApp outreach (§3.1.3) — set during the branch below, fired
  // after the lead is persisted. Each is OFF unless its template env is set.
  let becameUnreachable = false;
  let callbackTimeStr: string | null = null;

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
  } else if (handover.length > 0) {
    // Route to the sales team (§3.1): stop the AI drip, flag + log the reason,
    // and alert Slack. Preserve a "confirmed" status; otherwise the lead goes to
    // the manual queue for a counsellor instead of back into automated retries.
    leadData.status = status === "confirmed" ? "confirmed" : "manual_followup";
    leadData.needsHandover = true;
    leadData.handoverReason = handover.map((h) => h.label).join("; ");
    leadData.handoverAt = new Date();
    leadData.handoverTriggers = handover.map((h) => h.key);
    status = leadData.status;
    const canceled = await cancelScheduledCalls(lead.id);
    await notifyHandover(lead, handover, input.transcript);
    logger.info(
      `Lead ${lead.id} handed to sales (${leadData.handoverTriggers.join(",")}) — canceled ${canceled} pending`,
    );
  } else if (input.outcome === "rescheduled" || callbackAt) {
    // Lead asked to be called back (§3.1.2). If they named a time, honour it;
    // a vague "call me back" with no time defaults to the evening callback hour
    // (7 PM IST). Either way: cancel the auto-retry ladder and queue a single
    // call at the target — DND-adjusted, so out-of-hours requests still comply.
    const target = callbackAt ?? nextEveningCallback();
    status = "rescheduled";
    leadData.status = "rescheduled";
    leadData.callbackAt = target;
    callbackTimeStr = istTime(target);
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
      becameUnreachable = true;
      logger.info(`Lead ${lead.id} unreachable after ${attemptNumber} attempts`);
    }
  }

  await prisma.lead.update({ where: { id: lead.id }, data: leadData });

  // Automated WhatsApp outreach (§3.1.3) — best-effort, each gated by its env
  // template (unset = off). Skipped automatically when the lead has opted out.
  const fn = firstName(lead.name);
  if (input.outcome === "confirmed") {
    await sendAutomatedTemplate(lead.id, outreachTemplate.confirmed(), [fn]);
  }
  if (becameUnreachable) {
    await sendAutomatedTemplate(lead.id, outreachTemplate.unreachable(), [fn]);
  }
  if (callbackTimeStr) {
    await sendAutomatedTemplate(lead.id, outreachTemplate.callback(), [fn, callbackTimeStr]);
  }

  logger.info(
    `Recorded ${input.callType} call ${call.id} for lead ${lead.id} (attempt ${attemptNumber}, status=${status})`,
  );
  return { ok: true, call };
}
