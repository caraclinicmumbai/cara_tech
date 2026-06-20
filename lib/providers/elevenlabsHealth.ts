// ElevenLabs health + credit monitor (§3.1.14). Periodically checks that the
// ElevenLabs API is reachable, the key is valid, and credits aren't exhausted —
// and alerts the sales team on Slack when something's wrong, BEFORE calls fail.
//
// Uses GET /v1/user/subscription: it requires auth (validates the key), confirms
// reachability, and reports character usage/limit (the account's credit meter).
import axios from "axios";
import { sendSlack } from "@/lib/slack";
import { logger } from "@/lib/logger";

const API_BASE = "https://api.elevenlabs.io";

// Alert when usage reaches this % of the limit (env-overridable).
const LOW_CREDIT_PCT = Number(process.env.ELEVENLABS_LOW_CREDIT_PCT ?? 90);
// While still in a bad state, re-alert at most this often (hours).
const REALERT_MS = Number(process.env.ELEVENLABS_REALERT_HOURS ?? 3) * 3_600_000;

export type HealthResult =
  | { status: "ok"; used: number; limit: number; remaining: number; pct: number }
  | { status: "low_credits"; used: number; limit: number; remaining: number; pct: number }
  | { status: "auth"; detail: string }
  | { status: "down"; detail: string };

/// One-shot health probe. Never throws.
export async function checkElevenLabsHealth(): Promise<HealthResult> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { status: "auth", detail: "ELEVENLABS_API_KEY not configured" };

  try {
    const res = await axios.get(`${API_BASE}/v1/user/subscription`, {
      headers: { "xi-api-key": key },
      timeout: 10_000,
    });
    const used = Number(res.data?.character_count ?? 0);
    const limit = Number(res.data?.character_limit ?? 0);
    const remaining = Math.max(0, limit - used);
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    if (limit > 0 && pct >= LOW_CREDIT_PCT) {
      return { status: "low_credits", used, limit, remaining, pct };
    }
    return { status: "ok", used, limit, remaining, pct };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const code = err.response?.status;
      if (code === 401) return { status: "auth", detail: "401 — invalid or expired API key" };
      return { status: "down", detail: `HTTP ${code ?? "network"}: ${err.message}` };
    }
    return { status: "down", detail: String(err) };
  }
}

function alertText(h: HealthResult): string {
  switch (h.status) {
    case "down":
      return `🚨 *ElevenLabs API is DOWN* — outbound AI calls will fail. Route leads to manual calling. (${h.detail})`;
    case "auth":
      return `🚨 *ElevenLabs API key invalid/expired* — AI calls will fail until the key is fixed. (${h.detail})`;
    case "low_credits":
      return `⚠️ *ElevenLabs credits low* — ${h.pct.toFixed(0)}% used (${h.remaining.toLocaleString()} of ${h.limit.toLocaleString()} left). Top up to avoid call failures.`;
    case "ok":
      return `✅ ElevenLabs recovered — AI calls can resume.`;
  }
}

// In-memory debounce state (resets on worker restart, which is fine).
let lastStatus: HealthResult["status"] | null = null;
let lastAlertAt = 0;

/// Run a check and alert Slack on a bad state. Alerts immediately on a state
/// change, then at most every REALERT_MS while still bad, and once on recovery.
export async function monitorElevenLabs(now: number = Date.now()): Promise<HealthResult> {
  const h = await checkElevenLabsHealth();
  const bad = h.status !== "ok";

  if (bad) {
    const changed = lastStatus !== h.status;
    const stale = now - lastAlertAt > REALERT_MS;
    if (changed || stale) {
      await sendSlack({ text: alertText(h) });
      lastAlertAt = now;
      logger.warn(`ElevenLabs health alert sent: ${h.status}`);
    }
  } else if (lastStatus && lastStatus !== "ok") {
    // Was bad, now ok → recovery notice.
    await sendSlack({ text: alertText(h) });
    logger.info("ElevenLabs recovered — Slack notified");
  }

  lastStatus = h.status;
  return h;
}
