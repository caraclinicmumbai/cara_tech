// Branch Manager daily digest (§3.1). Once a day (default 09:00 IST) the worker
// posts a Slack summary of the previous day to the branch manager:
//   • Leads received (with the top sources)
//   • AI contact rate — of AI call attempts, how many reached a human
//   • Human-callback-pending leads beyond the handover SLA (a live snapshot)
//   • Premature Lost flags raised
//
// Scheduling uses a BullMQ repeatable (cron) job so it fires once per day even
// across worker restarts. Best-effort: a Slack/DB error is logged, never thrown.
import { Queue } from "bullmq";
import { bullConnection } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { slaHours } from "@/lib/handoverSla";
import { logger } from "@/lib/logger";

export const DIGEST_QUEUE = "daily-digest";
export const DIGEST_JOB = "branchManagerDigest";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MIN = 5 * 60 + 30; // +05:30 (no DST)

// AI-call outcomes that mean the lead was actually REACHED (a decision logged).
const REACHED_OUTCOMES = ["confirmed", "rescheduled", "not_interested"];
// Call types placed by the AI (excludes human_handover).
const AI_CALL_TYPES = ["initial", "reconfirmation"];

/// Where the digest goes — the branch manager's channel or Slack user id.
export function branchManagerChannel(): string | undefined {
  return process.env.BRANCH_MANAGER_CHANNEL ?? process.env.SLACK_DEFAULT_CHANNEL;
}

/// Hour (IST, 0–23) the digest is sent. Default 9 AM.
export function digestHour(): number {
  const h = Number(process.env.DIGEST_HOUR_IST ?? 9);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

/// The previous IST calendar day as a [start, end) UTC range. At 09:00 IST this is
/// "yesterday 00:00 → today 00:00" IST.
export function previousIstDay(now: Date = new Date()): { start: Date; end: Date; label: string } {
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const istMidnightToday = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  const startShifted = istMidnightToday - DAY_MS; // start of yesterday (IST-shifted epoch)
  const start = new Date(startShifted - IST_OFFSET_MIN * 60_000);
  const end = new Date(istMidnightToday - IST_OFFSET_MIN * 60_000);
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(start);
  return { start, end, label };
}

export type DigestMetrics = {
  label: string;
  leadsReceived: number;
  topSources: { source: string; count: number }[];
  aiAttempted: number;
  aiReached: number;
  contactRatePct: number | null;
  callbackPendingBeyondSla: { count: number; names: string[]; slaH: number };
  prematureLost: number;
};

/// Compute the digest metrics for a [start, end) window. `callbackPendingBeyondSla`
/// is a LIVE snapshot (handovers still unattended past the SLA), not windowed.
export async function computeDigestMetrics(
  start: Date,
  end: Date,
  label: string,
): Promise<DigestMetrics> {
  const window = { gte: start, lt: end };

  // 1. Leads received + top sources.
  const received = await prisma.lead.findMany({
    where: { createdAt: window },
    select: { source: true },
  });
  const leadsReceived = received.length;
  const sourceCounts = new Map<string, number>();
  for (const l of received) {
    const s = l.source ?? "unknown";
    sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
  }
  const topSources = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // 2. AI contact rate (reached / attempted) over AI call attempts in the window.
  const aiAttempted = await prisma.call.count({
    where: { createdAt: window, callType: { in: AI_CALL_TYPES } },
  });
  const aiReached = await prisma.call.count({
    where: { createdAt: window, callType: { in: AI_CALL_TYPES }, outcome: { in: REACHED_OUTCOMES } },
  });
  const contactRatePct = aiAttempted > 0 ? Math.round((aiReached / aiAttempted) * 100) : null;

  // 3. Human callback pending beyond SLA (live snapshot): leads still flagged for
  //    handover whose handover fired more than slaH ago and that have had no call
  //    since. Mirrors the handover-SLA "unattended" definition.
  const slaH = slaHours();
  const cutoff = new Date(Date.now() - slaH * 60 * 60_000);
  const pendingCandidates = await prisma.lead.findMany({
    where: { needsHandover: true, handoverAt: { lt: cutoff } },
    select: { id: true, name: true, handoverAt: true },
    orderBy: { handoverAt: "asc" },
    take: 200,
  });
  const pendingNames: string[] = [];
  for (const l of pendingCandidates) {
    const callsAfter = await prisma.call.count({
      where: { leadId: l.id, createdAt: { gt: l.handoverAt ?? start } },
    });
    if (callsAfter === 0) pendingNames.push(l.name);
  }

  // 4. Premature Lost flags raised in the window.
  const prematureLost = await prisma.lead.count({
    where: { prematureLost: true, lostAt: window },
  });

  return {
    label,
    leadsReceived,
    topSources,
    aiAttempted,
    aiReached,
    contactRatePct,
    callbackPendingBeyondSla: { count: pendingNames.length, names: pendingNames.slice(0, 10), slaH },
    prematureLost,
  };
}

/// Render the digest as Slack blocks + fallback text.
export function buildDigestMessage(m: DigestMetrics): { text: string; blocks: unknown[] } {
  const sources = m.topSources.length
    ? m.topSources.map((s) => `${s.source} ${s.count}`).join(" · ")
    : "—";
  const contact =
    m.contactRatePct == null
      ? "no AI calls"
      : `${m.contactRatePct}% (${m.aiReached}/${m.aiAttempted} reached)`;
  const pending = m.callbackPendingBeyondSla;
  const pendingLine =
    pending.count === 0
      ? `*Callback pending > ${pending.slaH}h SLA:* none ✅`
      : `*Callback pending > ${pending.slaH}h SLA:* ${pending.count}\n${pending.names.map((n) => `• ${n}`).join("\n")}`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `📊 Daily digest — ${m.label}`, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Leads received:*\n${m.leadsReceived}` },
        { type: "mrkdwn", text: `*AI contact rate:*\n${contact}` },
        { type: "mrkdwn", text: `*Top sources:*\n${sources}` },
        { type: "mrkdwn", text: `*Premature lost flags:*\n${m.prematureLost}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: pendingLine } },
  ];

  const text =
    `📊 Daily digest — ${m.label}: ${m.leadsReceived} leads, ` +
    `AI contact ${m.contactRatePct == null ? "n/a" : `${m.contactRatePct}%`}, ` +
    `${pending.count} callback(s) beyond SLA, ${m.prematureLost} premature lost`;
  return { text, blocks };
}

/// Compute + send the daily digest for the previous IST day. Best-effort.
export async function sendDailyDigest(): Promise<DigestMetrics | null> {
  const channel = branchManagerChannel();
  if (!isSlackConfigured() || !channel) {
    logger.warn("Daily digest skipped — Slack/branch-manager channel not configured");
    return null;
  }
  try {
    const { start, end, label } = previousIstDay();
    const metrics = await computeDigestMetrics(start, end, label);
    const { text, blocks } = buildDigestMessage(metrics);
    await sendSlack({ text, blocks, channel });
    logger.info(`Daily digest sent for ${label} (${metrics.leadsReceived} leads)`);
    return metrics;
  } catch (err) {
    logger.error(`Daily digest failed: ${String(err)}`);
    return null;
  }
}

let _q: Queue | undefined;
function getDigestQueue(): Queue {
  if (!_q) _q = new Queue(DIGEST_QUEUE, { connection: bullConnection });
  return _q;
}

/// Register the daily repeatable job at digestHour() IST. Idempotent — BullMQ
/// dedups repeatables by key, so calling this on every worker boot is safe.
export async function scheduleDailyDigest(): Promise<void> {
  const hour = digestHour();
  await getDigestQueue().add(
    DIGEST_JOB,
    {},
    {
      repeat: { pattern: `0 ${hour} * * *`, tz: "Asia/Kolkata" },
      jobId: "daily-digest-cron",
      removeOnComplete: 30,
      removeOnFail: 30,
    },
  );
  logger.info(`Daily digest scheduled for ${String(hour).padStart(2, "0")}:00 IST`);
}
