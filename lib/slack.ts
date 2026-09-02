// Slack notifications for staff (§3.1.17 notification architecture).
// Uses a Slack bot token (chat.postMessage) so we can post to channels now and
// DM individual employees later (pass their Slack user ID as `channel`).
//
// Fail-safe by design: a notification must NEVER break the request that
// triggered it. Missing config or a Slack error is logged and swallowed.
import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";

const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

/// Verify an inbound Slack request (interactivity / slash command). Slack signs
/// `v0:${timestamp}:${rawBody}` with the app Signing Secret (HMAC-SHA256). Rejects
/// stale requests (>5 min) to block replay. `rawBody` MUST be the exact bytes.
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type SlackMessage = {
  /// Fallback / notification text (also shown when blocks aren't rendered).
  text: string;
  /// Channel ID or name (e.g. "#cara-alerts"), or a user ID for a DM.
  /// Defaults to SLACK_DEFAULT_CHANNEL.
  channel?: string;
  /// Optional Block Kit blocks for rich formatting.
  blocks?: unknown[];
};

/// Returns true once Slack is configured (token + a default channel).
export function isSlackConfigured(): boolean {
  return !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_DEFAULT_CHANNEL;
}

/// Does this look like something Slack can actually deliver to?
///
/// Slack ids are letter-prefixed and upper-case: `U…`/`W…` a person, `C…`/`G…`/`D…` a
/// channel or DM. A `#name` is fine too. Anything else — most often a human's handle
/// typed into `SalesRep.slackUserId`, e.g. "rohit" — is not addressable, and Slack
/// answers `channel_not_found`.
///
/// This matters more than it looks. Five places DM a counsellor by their `slackUserId`
/// (handover, escalation, ownership, CQS extremes, follow-up reminders). With an
/// unusable id, every one of those messages was being dropped for that person and the
/// only trace was one line in the log.
const ADDRESSABLE = /^(#|[UWCGD][A-Z0-9]{6,}$)/;

export function isAddressableSlackTarget(target: string | null | undefined): boolean {
  return !!target && ADDRESSABLE.test(target.trim());
}

/// Post a message to Slack. Returns true on success, false (logged) otherwise.
/// Never throws.
///
/// A message addressed at a specific person FALLS BACK to the default channel when that
/// address doesn't work, rather than vanishing. A handover alert in the shared channel
/// is imperfect; a handover alert nobody receives is a lead going cold.
export async function sendSlack(msg: SlackMessage): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  const fallback = process.env.SLACK_DEFAULT_CHANNEL;
  // An unusable target is treated as no target at all, so it goes straight to the
  // shared channel instead of burning a round trip to be told it doesn't exist.
  const requested =
    msg.channel && isAddressableSlackTarget(msg.channel) ? msg.channel.trim() : undefined;
  if (msg.channel && !requested) {
    logger.warn(
      `Slack target "${msg.channel}" isn't a Slack id (expected U…/C…/#channel) — using the default channel instead`,
    );
  }
  const channel = requested ?? fallback;

  if (!token || !channel) {
    logger.warn("Slack not configured (SLACK_BOT_TOKEN / SLACK_DEFAULT_CHANNEL) — skipping notification");
    return false;
  }

  const post = async (to: string) => {
    const res = await axios.post(
      POST_MESSAGE_URL,
      { channel: to, text: msg.text, ...(msg.blocks ? { blocks: msg.blocks } : {}) },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        timeout: 10_000,
      },
    );
    // Slack returns HTTP 200 with { ok: false, error } on logical failures
    // (invalid_auth, channel_not_found, not_in_channel, …).
    return { ok: !!res.data?.ok, error: res.data?.error as string | undefined };
  };

  try {
    const first = await post(channel);
    if (first.ok) return true;

    // The address was well-formed but Slack can't reach it — a departed member, a
    // private channel the bot isn't in. Don't lose the message.
    const undeliverable = first.error === "channel_not_found" || first.error === "not_in_channel";
    if (undeliverable && fallback && channel !== fallback) {
      logger.warn(`Slack could not deliver to ${channel} (${first.error}) — retrying in the default channel`);
      const retry = await post(fallback);
      if (retry.ok) return true;
      logger.error(`Slack post failed on fallback too: ${retry.error ?? "unknown_error"}`);
      return false;
    }

    logger.error(`Slack post failed: ${first.error ?? "unknown_error"}`);
    return false;
  } catch (err) {
    logger.error(`Slack post error: ${String(err)}`);
    return false;
  }
}
