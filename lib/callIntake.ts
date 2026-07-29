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
import { advanceStage, type LeadStage } from "@/lib/leadStages";
import { evaluateHandover, notifyHandover } from "@/lib/handover";
import { scheduleHandoverSla } from "@/lib/handoverSla";
import { notifyCounsellor, type CounsellorAlertKind } from "@/lib/counsellor";
import { notifySalesHead } from "@/lib/salesHead";
import { writeAudit } from "@/lib/audit";
import { sendAutomatedTemplate, outreachTemplate, firstName, istTime } from "@/lib/outreach";
import { scoreCQS } from "@/lib/cqs";
import { runStageChange } from "@/lib/chatbotRuntime";
import { enrollLead } from "@/lib/campaigns/engine";
import { classifyFromCall } from "@/lib/campaigns/classify";
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

  // Idempotency (§ reliability): ElevenLabs and n8n both retry on timeout/5xx. If
  // this conversation is already recorded, return it WITHOUT re-scoring (paid),
  // re-alerting, or re-scheduling — a duplicate would also corrupt the attempt count.
  if (input.elevenlabsId) {
    const existing = await prisma.call.findUnique({ where: { elevenlabsId: input.elevenlabsId } });
    if (existing) {
      logger.info(`Duplicate post-call for ${input.elevenlabsId} — already recorded (call ${existing.id}); skipping`);
      return { ok: true, call: existing };
    }
  }

  // Opt-out re-check (§ reliability R5): a lead can opt out (STOP on WhatsApp)
  // in the window between this call being PLACED and its result arriving. Persist
  // the Call for the record, but suppress EVERYTHING downstream — no CQS spend,
  // stage advance, retry, handover, template send, or campaign enrollment. (An
  // opt-out DECIDED on THIS call arrives as outcome "not_interested" and is handled
  // in the main flow below; this guards the ALREADY-opted-out state.)
  if (lead.optedOut) {
    try {
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
      logger.info(`Lead ${lead.id} already opted out — recorded call ${call.id}, suppressed all outreach/retry/handover`);
      return { ok: true, call };
    } catch (err) {
      // Lost the race to a concurrent duplicate webhook (unique elevenlabsId).
      if ((err as { code?: string }).code === "P2002" && input.elevenlabsId) {
        const existing = await prisma.call.findUnique({ where: { elevenlabsId: input.elevenlabsId } });
        if (existing) return { ok: true, call: existing };
      }
      throw err;
    }
  }

  // Conversation Quality Score (§3.1) — Claude scores the transcript against the
  // rubric. Best-effort: null when unconfigured/empty/failed. The computed score
  // also drives the high-CQS handover trigger below. Computed BEFORE the DB
  // transaction (a slow external call must not hold a transaction open).
  const scored = await scoreCQS(input.transcript);

  // This call's attempt number = prior AI calls + 1. Count ONLY AI call types so a
  // human_handover recording can't inflate the ladder index (which would
  // mis-schedule the next retry or prematurely mark the lead unreachable).
  const attemptNumber =
    (await prisma.call.count({
      where: { leadId: lead.id, callType: { in: ["initial", "reconfirmation"] } },
    })) + 1;

  // Side-effects (queue ops, Slack, WhatsApp) are deferred until AFTER the DB write
  // commits: a rollback then leaves no orphaned jobs/alerts, and the Call + Lead are
  // written atomically so a mid-pipeline crash can't leave the Call recorded but the
  // Lead un-advanced (which would stall the lead forever).
  const afterCommit: Array<() => Promise<void>> = [];
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
    stageChangedAt?: Date;
    stageStuckNotifiedAt?: Date | null;
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
    cqs: scored?.cqs ?? input.cqs, // prefer our computed CQS over any agent-provided value
    language: input.language,
  });

  // Tag: what the lead asked for, as captured by the AI. Only overwrite when the
  // call actually carried one — an empty extraction shouldn't wipe a manual tag.
  const tag = input.tag?.trim();
  if (tag) leadData.tag = tag;

  // Automated WhatsApp outreach (§3.1.3) — set during the branch below, fired
  // after the lead is persisted. Each is OFF unless its template env is set.
  let becameUnreachable = false;
  let retryScheduled = false;
  let callbackTimeStr: string | null = null;

  if (input.outcome === "not_interested") {
    // Hard opt-out (§3.1.10): the lead said they're not interested. Mark them,
    // suppress ALL further outreach, and cancel any pending retries/callbacks.
    status = "not_interested";
    leadData.status = "not_interested";
    leadData.optedOut = true;
    leadData.optedOutAt = new Date();
    leadData.optedOutReason = "Said not interested on AI call";
    afterCommit.push(async () => {
      const canceled = await cancelScheduledCalls(lead.id);
      await writeAudit({
        action: "lead.consent.change", entityType: "lead", entityId: lead.id,
        field: "optedOut", oldValue: "false", newValue: "true", reason: "Said not interested on AI call",
      });
      logger.info(`Lead ${lead.id} opted out (not interested) — suppressed all outreach, canceled ${canceled} pending`);
    });
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
    // Counsellor oversight copy (§3.1): one alert per handover, framed by the most
    // significant trigger — a threat (abusive) and a fast-track (high CQS) each
    // get distinct treatment; everything else is a generic AI handoff.
    const keys = leadData.handoverTriggers;
    const kind: CounsellorAlertKind = keys.includes("abusive")
      ? "threat"
      : keys.includes("high_cqs")
        ? "fast_track"
        : "ai_handoff";
    const handoverReason = leadData.handoverReason;
    const handoverSince = leadData.handoverAt.getTime();
    const cqsForAlerts = scored?.cqs ?? input.cqs;
    afterCommit.push(async () => {
      const canceled = await cancelScheduledCalls(lead.id);
      await notifyHandover(lead, handover, input.transcript, cqsForAlerts);
      await notifyCounsellor({ kind, lead, reason: handoverReason, cqs: cqsForAlerts });
      // SLA timer: if no rep attends within HANDOVER_SLA_HOURS, escalate (§3.1).
      await scheduleHandoverSla({ leadId: lead.id, since: handoverSince, reason: handoverReason });
      logger.info(`Lead ${lead.id} handed to sales (${keys.join(",")}) — canceled ${canceled} pending`);
    });
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
    afterCommit.push(async () => {
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
    });
  } else if (unanswered) {
    const delays = retryDelaysDays(); // e.g. [1, 5]
    const maxAttempts = delays.length + 1; // + the immediate intake call
    if (attemptNumber < maxAttempts) {
      retryScheduled = true;
      const delayDays = delays[attemptNumber - 1] ?? delays[delays.length - 1]!; // attempt N→N+1
      const nextAttempt = attemptNumber + 1;
      afterCommit.push(async () => {
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
      });
    } else {
      // Exhausted all attempts with no answer — mark unreachable (fallback queue).
      status = "unreachable";
      leadData.status = "unreachable";
      becameUnreachable = true;
      logger.info(`Lead ${lead.id} unreachable after ${attemptNumber} attempts`);
    }
  }

  // Pipeline stage (§3.1) — auto-advance FORWARD-ONLY based on what this call
  // resolved to. Priority mirrors the branch handling above:
  //   handover → Human Callback Pending; confirmed → Appointment Scheduled;
  //   asked-to-call-later → Communication Not Established; exhausted retries →
  //   AI Attempted — Unreachable. not_interested is opt-out only (no stage move),
  //   and an engaged call with no other signal simply stays at AI Contacted.
  let eventStage: LeadStage | null = null;
  if (input.outcome === "not_interested") {
    eventStage = null;
  } else if (handover.length > 0) {
    eventStage = "human_callback_pending";
  } else if (input.outcome === "confirmed") {
    eventStage = "appointment_scheduled";
  } else if (callbackAt || input.outcome === "rescheduled") {
    eventStage = "communication_not_established";
  } else if (becameUnreachable) {
    eventStage = "ai_attempted_unreachable";
  }
  const nextStage = advanceStage(lead.stage, eventStage);
  if (nextStage) {
    leadData.stage = nextStage;
    // Reset the stage-age clock (+ clear any stuck alert) so the stuck-in-stage SLA
    // measures time in the NEW stage (§3.1).
    leadData.stageChangedAt = new Date();
    leadData.stageStuckNotifiedAt = null;
    // §matrix: auto-advancing the stage may fire a stage_change chatbot flow too.
    afterCommit.push(async () => {
      await runStageChange(lead.id, nextStage);
    });
  }

  // Sales-head CQS-extreme ping (§3.1) — independent of any handover: fires for
  // EVERY scored call whose CQS is very high or very low, DMing the sales head.
  afterCommit.push(async () => {
    await notifySalesHead(lead, scored?.cqs);
  });

  // Follow-up auto-enrollment (§follow-up) — sort the lead into a campaign from how the
  // call went (couldnt_reach / worried_cost / just_researching), handover always winning.
  // enrollLead self-guards (kill-switch, exclusions, opt-out, one-active-per-person), so a
  // null classification or an already-enrolled lead is a safe no-op.
  afterCommit.push(async () => {
    const campaign = classifyFromCall({
      becameUnreachable,
      retryScheduled,
      handoverFired: handover.length > 0,
      // Hot lead = the high-CQS (score ≥ threshold) handover fired → the fast-track routing campaign.
      hotLead: handover.some((h) => h.key === "high_cqs"),
      optedOut: input.outcome === "not_interested",
      confirmed: input.outcome === "confirmed",
      callbackScheduled: input.outcome === "rescheduled" || !!callbackAt,
      answered: !!input.transcript && input.outcome !== "no_answer",
      tag: leadData.tag ?? lead.tag,
      handoverReasons: input.handoverReasons,
      interestLevel: lead.interestLevel,
    });
    if (!campaign) return;
    const res = await enrollLead(lead.id, campaign);
    logger.info(
      res.ok
        ? `Lead ${lead.id} auto-enrolled in "${campaign}" campaign (${res.enrollmentId})`
        : `Auto-enroll ("${campaign}") skipped for lead ${lead.id}: ${res.reason}`,
    );
  });

  // Atomic write (§ reliability): the Call and the Lead update land together, or
  // neither does — no "Call recorded but Lead un-advanced" stall on a crash.
  let call: Call;
  try {
    call = await prisma.$transaction(async (tx) => {
      const created = await tx.call.create({
        data: {
          leadId: input.leadId,
          callType: input.callType,
          elevenlabsId: input.elevenlabsId,
          transcript: input.transcript,
          outcome: input.outcome,
          sentiment: input.sentiment,
          duration: input.duration,
          cqs: scored?.cqs,
          cqsBreakdown: scored?.breakdown,
        },
      });
      await tx.lead.update({ where: { id: lead.id }, data: leadData });
      return created;
    });
  } catch (err) {
    // Lost the race to a concurrent duplicate webhook (the unique elevenlabsId
    // constraint fired) — treat as already-processed rather than erroring.
    if ((err as { code?: string }).code === "P2002" && input.elevenlabsId) {
      const existing = await prisma.call.findUnique({ where: { elevenlabsId: input.elevenlabsId } });
      if (existing) {
        logger.info(`Concurrent duplicate for ${input.elevenlabsId} — already recorded; skipping`);
        return { ok: true, call: existing };
      }
    }
    throw err;
  }

  // Post-commit side-effects (queue scheduling + Slack), best-effort and isolated
  // so one failure can't abort the rest.
  for (const action of afterCommit) {
    await action().catch((err) => logger.error(`Post-commit action failed for lead ${lead.id}: ${String(err)}`));
  }

  // Automated WhatsApp outreach (§3.1.3) — best-effort, each gated by its env
  // template (unset = off). Skipped automatically when the lead has opted out.
  const first = firstName(lead.name);
  if (input.outcome === "confirmed") {
    await sendAutomatedTemplate(lead.id, outreachTemplate.confirmed(), [first]);
  }
  if (becameUnreachable) {
    await sendAutomatedTemplate(lead.id, outreachTemplate.unreachable(), [first]);
  }
  if (callbackTimeStr) {
    await sendAutomatedTemplate(lead.id, outreachTemplate.callback(), [first, callbackTimeStr]);
  }

  logger.info(
    `Recorded ${input.callType} call ${call.id} for lead ${lead.id} (attempt ${attemptNumber}, status=${status})`,
  );
  return { ok: true, call };
}
