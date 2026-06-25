// Handover SLA escalation (§3.1). When a "call this lead" alert is sent to a
// salesperson (an AI→human handover), we start a timer. If the rep hasn't
// attended the lead within HANDOVER_SLA_HOURS (default 2h), the lead is escalated
// up to the counsellor / supervisor on Slack so it doesn't go cold.
//
// "Attended" = the handover was resolved (needsHandover cleared) OR a call was
// logged for the lead after the handover fired (the rep called them — e.g. via
// the in-app Call & record button). NOTE: a rep dialling from their personal
// phone via the tel: link leaves no Call record, so it reads as unattended — a
// false escalation there is low-harm (the counsellor just double-checks).
import { Queue } from "bullmq";
import { bullConnection } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { logger } from "@/lib/logger";

export const HANDOVER_SLA_QUEUE = "handover-sla";

export type HandoverSlaJob = {
  leadId: string;
  /// handoverAt epoch ms at scheduling time — identifies THIS handover cycle, so a
  /// later re-handover supersedes (it schedules its own check) and calls placed
  /// before the handover don't count as "attended".
  since: number;
  /// Human-readable reason the lead was handed over (for the escalation message).
  reason?: string;
};

let _q: Queue<HandoverSlaJob> | undefined;

export function getHandoverSlaQueue(): Queue<HandoverSlaJob> {
  if (!_q) {
    _q = new Queue<HandoverSlaJob>(HANDOVER_SLA_QUEUE, {
      connection: bullConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return _q;
}

/// Hours a salesperson has to attend a handover before it escalates. Default 2.
export function slaHours(): number {
  const h = Number(process.env.HANDOVER_SLA_HOURS ?? 2);
  return Number.isFinite(h) && h > 0 ? h : 2;
}

/// Where the unattended-lead escalation goes — a counsellor/supervisor channel or
/// Slack user id. Falls back to the default channel.
export function escalationTarget(): string | undefined {
  return process.env.HANDOVER_ESCALATION_CHANNEL ?? process.env.SLACK_DEFAULT_CHANNEL;
}

/// Schedule the SLA check for a handover that just fired. Idempotent per
/// (lead, handover cycle): re-handover of the same lead schedules a fresh check.
/// Best-effort — never throws into the caller.
export async function scheduleHandoverSla(job: HandoverSlaJob): Promise<void> {
  try {
    await getHandoverSlaQueue().add("slaCheck", job, {
      delay: slaHours() * 60 * 60 * 1000,
      jobId: `sla-${job.leadId}-${job.since}`,
    });
  } catch (err) {
    logger.error(`Failed to schedule handover SLA for lead ${job.leadId}: ${String(err)}`);
  }
}

export type SlaCheckResult =
  | { action: "skip"; reason: string }
  | { action: "escalated" };

/// Decide whether an unattended handover should escalate, and if so alert the
/// counsellor on Slack. Returns the outcome for logging. Never throws.
export async function runHandoverSlaCheck(job: HandoverSlaJob): Promise<SlaCheckResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: job.leadId },
    select: {
      id: true,
      name: true,
      phone: true,
      needsHandover: true,
      handoverAt: true,
      handoverReason: true,
      assignedRep: { select: { name: true, slackUserId: true } },
    },
  });
  if (!lead) return { action: "skip", reason: "lead not found" };

  // Resolved: the handover flag was cleared (lead converted / not interested / a
  // human marked it done) — nothing to escalate.
  if (!lead.needsHandover) return { action: "skip", reason: "handover resolved" };

  // Superseded: a newer handover cycle replaced this one (handoverAt moved
  // forward). That newer cycle scheduled its own check; this job is stale.
  if (lead.handoverAt && lead.handoverAt.getTime() > job.since + 1000) {
    return { action: "skip", reason: "superseded by a newer handover" };
  }

  // Attended: a call was logged AFTER the handover fired (the rep called them).
  const callsAfter = await prisma.call.count({
    where: { leadId: lead.id, createdAt: { gt: new Date(job.since) } },
  });
  if (callsAfter > 0) return { action: "skip", reason: "call logged after handover" };

  // Unattended → escalate to the counsellor.
  if (!isSlackConfigured() || !escalationTarget()) {
    return { action: "skip", reason: "Slack not configured" };
  }

  const base = process.env.NEXTAUTH_URL;
  const telPhone = lead.phone.replace(/[^\d+]/g, "");
  const phoneLink = `<tel:${telPhone}|📞 ${lead.phone}>`;
  const rep = lead.assignedRep;
  const assignee = rep?.slackUserId ? `<@${rep.slackUserId}>` : (rep?.name ?? "unassigned");
  const reason = job.reason || lead.handoverReason || "Handover to sales";
  const hrs = slaHours();

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `⏰ Unattended lead — ${hrs}h SLA breached`, emoji: true } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${lead.name}* — ${phoneLink}\nAssigned to ${assignee}, *no call logged in ${hrs}h*.`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: `*Original handover reason:*\n${reason}` } },
  ];
  if (base) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open lead" }, url: `${base}/leads/${lead.id}` },
      ],
    });
  }

  const text = `⏰ Unattended lead — ${lead.name} (${lead.phone}) not actioned in ${hrs}h (assigned to ${rep?.name ?? "nobody"})`;
  await sendSlack({ text, blocks, channel: escalationTarget() });
  logger.info(`Handover SLA escalated lead ${lead.id} to counsellor (unattended ${hrs}h)`);
  return { action: "escalated" };
}
