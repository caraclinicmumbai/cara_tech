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

/// Post a message to Slack. Returns true on success, false (logged) otherwise.
/// Never throws.
export async function sendSlack(msg: SlackMessage): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = msg.channel ?? process.env.SLACK_DEFAULT_CHANNEL;

  if (!token || !channel) {
    logger.warn("Slack not configured (SLACK_BOT_TOKEN / SLACK_DEFAULT_CHANNEL) — skipping notification");
    return false;
  }

  try {
    const res = await axios.post(
      POST_MESSAGE_URL,
      { channel, text: msg.text, ...(msg.blocks ? { blocks: msg.blocks } : {}) },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        timeout: 10_000,
      },
    );
    // Slack returns HTTP 200 with { ok: false, error } on logical failures
    // (invalid_auth, channel_not_found, not_in_channel, …).
    if (!res.data?.ok) {
      logger.error(`Slack post failed: ${res.data?.error ?? "unknown_error"}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.error(`Slack post error: ${String(err)}`);
    return false;
  }
}
