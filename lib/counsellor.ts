// Counsellor oversight notifications (§3.1). A single Slack feed to the counsellor
// / supervisor for the events they need to watch across the sales floor:
//   • ai_handoff      — an AI call handed a lead to sales
//   • fast_track      — a high-intent lead (CQS ≥ threshold)
//   • threat          — an abusive / threatening caller was flagged
//   • premature_lost  — a lead was marked Lost before completing a consultation
//   • stage_sla       — a lead has been stuck in a stage past the SLA
//
// Distinct from the per-rep handover DM (lib/handover.ts) — that's the actionable
// "go call them"; this is the counsellor's oversight copy. Best-effort: a missing
// channel or Slack error is logged and swallowed, never thrown.
import type { Lead } from "@prisma/client";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { logger } from "@/lib/logger";

export type CounsellorAlertKind =
  | "ai_handoff"
  | "fast_track"
  | "threat"
  | "premature_lost"
  | "stage_sla"
  | "missed_inbound";

const HEADERS: Record<CounsellorAlertKind, string> = {
  ai_handoff: "🤝 AI handoff — needs a counsellor",
  fast_track: "🔥 Fast-track lead — CQS ≥ 75",
  threat: "🚨 Threat / abusive lead flagged",
  premature_lost: "⚠️ Premature lost — review",
  stage_sla: "⏰ Lead stuck in stage",
  missed_inbound: "📞 Missed inbound call — voicemail left",
};

/// Where counsellor notifications go — a counsellor/supervisor channel or Slack
/// user id. Unifies with the handover-SLA escalation target; falls back to the
/// default channel.
export function counsellorChannel(): string | undefined {
  return (
    process.env.COUNSELLOR_CHANNEL ??
    process.env.HANDOVER_ESCALATION_CHANNEL ??
    process.env.SLACK_DEFAULT_CHANNEL
  );
}

/// Post a counsellor oversight alert. Best-effort; never throws.
export async function notifyCounsellor(opts: {
  kind: CounsellorAlertKind;
  lead: Pick<Lead, "id" | "name" | "phone">;
  /// Primary reason line (handover reason, lost reason, stage label…).
  reason?: string;
  /// Extra context lines appended under the reason.
  extra?: string[];
  cqs?: number;
}): Promise<void> {
  const { kind, lead, reason, extra, cqs } = opts;
  const channel = counsellorChannel();
  if (!isSlackConfigured() || !channel) {
    logger.warn(`Counsellor alert (${kind}) skipped — Slack/channel not configured`);
    return;
  }

  const base = process.env.NEXTAUTH_URL;
  const telPhone = lead.phone.replace(/[^\d+]/g, "");
  const phoneLink = `<tel:${telPhone}|📞 ${lead.phone}>`;
  const cqsTag = typeof cqs === "number" ? ` · CQS ${cqs}` : "";

  const lines = [`*${lead.name}* — ${phoneLink}${cqsTag}`];
  if (reason) lines.push(`*Reason:* ${reason}`);
  for (const e of extra ?? []) lines.push(e);

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: HEADERS[kind], emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  if (base) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open lead" }, url: `${base}/leads/${lead.id}` },
      ],
    });
  }

  const text = `${HEADERS[kind]} — ${lead.name} (${lead.phone})${reason ? `: ${reason}` : ""}`;
  await sendSlack({ text, blocks, channel });
  logger.info(`Counsellor alert (${kind}) for lead ${lead.id}`);
}
