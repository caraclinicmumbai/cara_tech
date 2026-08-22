// Live-chat fan-out (§3.1.3 realtime). Whenever a lead's WhatsApp thread changes
// — an inbound reply lands on the webhook, an agent or the chatbot sends, a
// delivery status ticks over — we publish the lead id on one Redis channel. The
// SSE stream at /api/leads/[id]/messages/stream is subscribed to it and pushes
// the delta to every open chat window within milliseconds.
//
// Redis is a NUDGE, not the transport: the stream also polls on a slow timer, so
// a Redis outage degrades chat to a few seconds of latency instead of breaking
// it. Publishing is best-effort and never throws into the send path.
import IORedis from "ioredis";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export const LEAD_MESSAGE_CHANNEL = "cara:lead-messages";

/// Nudge every open chat window for this lead that its thread changed.
export async function publishLeadMessageEvent(leadId: string): Promise<void> {
  if (!leadId) return;
  try {
    await redis.publish(LEAD_MESSAGE_CHANNEL, leadId);
  } catch (err) {
    logger.warn(`Realtime publish failed for lead ${leadId}: ${String(err)}`);
  }
}

/// Open a dedicated subscriber connection (a connection in subscriber mode can't
/// run other commands, so the shared BullMQ client can't be reused) and call
/// `onLead` for each nudge. Returns a disposer; null when Redis is unreachable —
/// the caller then relies on its polling fallback.
export async function subscribeLeadMessages(
  onLead: (leadId: string) => void,
): Promise<(() => void) | null> {
  let sub: IORedis;
  try {
    sub = redis.duplicate();
  } catch (err) {
    logger.warn(`Realtime subscribe failed to duplicate connection: ${String(err)}`);
    return null;
  }
  // Errors on a subscriber are recoverable (ioredis reconnects); log once, never throw.
  sub.on("error", (err) => logger.warn(`Realtime subscriber error: ${String(err)}`));
  sub.on("message", (_channel, payload) => onLead(payload));
  try {
    await sub.subscribe(LEAD_MESSAGE_CHANNEL);
  } catch (err) {
    logger.warn(`Realtime subscribe failed: ${String(err)}`);
    sub.disconnect();
    return null;
  }
  return () => {
    try {
      sub.disconnect();
    } catch {
      /* already gone */
    }
  };
}
