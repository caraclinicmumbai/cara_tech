// Sales-head escalation (§3.1). The sales head is a manager, not a line
// telecaller: they're kept out of the round-robin rota and pinged ONLY on CQS
// extremes — a very-high score (an exceptional lead worth their personal touch)
// or a very-low score (a quality failure worth their review). Best-effort: any
// missing config or Slack error is logged and swallowed, never thrown.
import type { Lead } from "@prisma/client";
import { getSalesHead } from "@/lib/salesReps";
import { isSlackConfigured, sendSlack } from "@/lib/slack";
import { logger } from "@/lib/logger";

/// CQS at/above this is "exceptional" → ping the sales head. Default 90.
function highThreshold(): number {
  return Number(process.env.SALES_HEAD_CQS_HIGH ?? 90);
}
/// CQS at/below this is a "quality failure" → ping the sales head. Default 15.
function lowThreshold(): number {
  return Number(process.env.SALES_HEAD_CQS_LOW ?? 15);
}

/// Is this score extreme enough for the sales head to see?
export function isSalesHeadScore(cqs?: number | null): boolean {
  if (typeof cqs !== "number" || Number.isNaN(cqs)) return false;
  return cqs >= highThreshold() || cqs <= lowThreshold();
}

/// DM the sales head about a CQS-extreme call. No-op unless the score is extreme,
/// a sales head with a Slack id is configured, and Slack is set up.
export async function notifySalesHead(
  lead: Pick<Lead, "id" | "name" | "phone">,
  cqs?: number | null,
): Promise<void> {
  if (!isSalesHeadScore(cqs)) return;

  const head = await getSalesHead();
  if (!head?.slackUserId) {
    logger.info(`Sales-head CQS alert for lead ${lead.id} (CQS ${cqs}) skipped — no sales head with a Slack id`);
    return;
  }
  if (!isSlackConfigured()) return;

  const score = cqs as number;
  const high = score >= highThreshold();
  const header = high
    ? `🌟 Exceptional call — CQS ${score}`
    : `⚠️ Low-quality call — CQS ${score}`;
  const followUp = high
    ? "A standout conversation — may be worth your personal touch to close."
    : "This call scored very low — worth a review.";

  const phoneLink = `<tel:${lead.phone}|${lead.phone}>`;
  const base = (process.env.TWILIO_PUBLIC_BASE ?? process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
  const leadLink = base ? ` · <${base}/leads/${lead.id}|Open lead>` : "";

  const text = `${header} — ${lead.name}`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `*${header}*` } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${lead.name}* — ${phoneLink}${leadLink}\n${followUp}` },
    },
  ];

  await sendSlack({ text, blocks, channel: head.slackUserId });
  logger.info(`Sales-head CQS alert for lead ${lead.id} (CQS ${score}) → ${head.name}`);
}
