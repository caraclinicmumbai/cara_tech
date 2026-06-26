// System downtime / API-failure monitor (§3.1). Runs in the worker on an interval
// and alerts the CRM admin + branch manager on Slack the moment a critical
// dependency goes down — and again when it recovers — so an outage is known
// before users feel it.
//
// Probes: Postgres, Redis, the CRM web app, and the external APIs that are
// configured (WhatsApp Graph, Twilio, Anthropic). ElevenLabs has its own credit-
// aware monitor (lib/providers/elevenlabsHealth.ts) and is left to it.
//
// Caveat: this runs IN the worker, so it can't report total-platform downtime
// (worker down, or Slack down). Pair it with an external uptime check on the web
// URL for that. What it DOES cover well: a dependency failing while the worker is
// alive — the common, actionable case.
import axios from "axios";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { branchManagerChannel } from "@/lib/digest";
import { isTwilioConfigured } from "@/lib/providers/twilio";
import { isWhatsAppConfigured } from "@/lib/providers/whatsapp";
import { logger } from "@/lib/logger";

export type SubsystemStatus = { name: string; ok: boolean; detail?: string };

// While a subsystem stays down, re-alert at most this often (hours).
const REALERT_MS = Number(process.env.HEALTH_REALERT_HOURS ?? 1) * 3_600_000;
// Require this many consecutive failed probes before declaring down (rides out
// transient blips / deploy restarts). Recovery is immediate (1 good probe).
const FAIL_THRESHOLD = Number(process.env.HEALTH_FAIL_THRESHOLD ?? 2);

const ok = (name: string): SubsystemStatus => ({ name, ok: true });
const down = (name: string, detail: string): SubsystemStatus => ({ name, ok: false, detail });

function httpDetail(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const code = err.response?.status;
    return code ? `HTTP ${code}` : `network: ${err.message}`;
  }
  return String(err);
}

async function checkDatabase(): Promise<SubsystemStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return ok("Database");
  } catch (err) {
    return down("Database", String(err).slice(0, 200));
  }
}

async function checkRedis(): Promise<SubsystemStatus> {
  try {
    const r = await redis.ping();
    return r === "PONG" ? ok("Redis") : down("Redis", `unexpected ping reply: ${r}`);
  } catch (err) {
    return down("Redis", String(err).slice(0, 200));
  }
}

async function checkWeb(): Promise<SubsystemStatus | null> {
  const base = process.env.NEXTAUTH_URL?.replace(/\/$/, "");
  if (!base) return null;
  try {
    const res = await axios.get(`${base}/login`, { timeout: 10_000, validateStatus: () => true });
    return res.status < 500 ? ok("CRM web") : down("CRM web", `HTTP ${res.status}`);
  } catch (err) {
    return down("CRM web", httpDetail(err));
  }
}

async function checkWhatsApp(): Promise<SubsystemStatus | null> {
  if (!isWhatsAppConfigured()) return null;
  const ver = process.env.META_GRAPH_VERSION ?? "v21.0";
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    const res = await axios.get(`https://graph.facebook.com/${ver}/${phoneId}`, {
      params: { fields: "id" },
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (res.status === 200) return ok("WhatsApp API");
    const detail = res.status === 401 || res.status === 400 ? `auth/token (HTTP ${res.status})` : `HTTP ${res.status}`;
    return down("WhatsApp API", detail);
  } catch (err) {
    return down("WhatsApp API", httpDetail(err));
  }
}

async function checkTwilio(): Promise<SubsystemStatus | null> {
  if (!isTwilioConfigured()) return null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  try {
    const res = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      auth: { username: sid!, password: token! },
      timeout: 10_000,
      validateStatus: () => true,
    });
    return res.status === 200 ? ok("Twilio API") : down("Twilio API", `HTTP ${res.status}`);
  } catch (err) {
    return down("Twilio API", httpDetail(err));
  }
}

async function checkAnthropic(): Promise<SubsystemStatus | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    // GET /v1/models validates the key + reachability and is not billed.
    const res = await axios.get("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (res.status === 200) return ok("Anthropic API");
    return down("Anthropic API", res.status === 401 ? "401 — invalid key" : `HTTP ${res.status}`);
  } catch (err) {
    return down("Anthropic API", httpDetail(err));
  }
}

const CHECKS = [checkDatabase, checkRedis, checkWeb, checkWhatsApp, checkTwilio, checkAnthropic];

/// Recipients of downtime alerts — CRM admin + branch manager (deduped). Falls
/// back to the default channel (sendSlack resolves `undefined` → default).
function alertTargets(): (string | undefined)[] {
  const set = new Set<string>();
  if (process.env.CRM_ADMIN_CHANNEL) set.add(process.env.CRM_ADMIN_CHANNEL);
  const bm = branchManagerChannel();
  if (bm) set.add(bm);
  return set.size ? [...set] : [undefined];
}

async function alertAdmins(text: string): Promise<void> {
  if (!isSlackConfigured()) {
    logger.warn(`Health alert suppressed (Slack not configured): ${text}`);
    return;
  }
  for (const channel of alertTargets()) await sendSlack({ text, channel });
}

// Per-subsystem debounce state (in-memory; resets on worker restart — fine).
type State = { down: boolean; lastAlertAt: number; fails: number };
const state = new Map<string, State>();

/// Probe every subsystem and alert on state changes. Alerts the admins when a
/// subsystem has failed FAIL_THRESHOLD times in a row (then at most every
/// REALERT_MS while still down), and once on recovery. Never throws.
export async function monitorSystemHealth(now: number = Date.now()): Promise<SubsystemStatus[]> {
  const settled = await Promise.all(CHECKS.map((c) => c().catch((e) => down("?", String(e)))));
  const results = settled.filter((r): r is SubsystemStatus => r != null && r.name !== "?");

  for (const r of results) {
    const s = state.get(r.name) ?? { down: false, lastAlertAt: 0, fails: 0 };

    if (!r.ok) {
      s.fails += 1;
      if (s.fails >= FAIL_THRESHOLD) {
        const justDown = !s.down;
        const stale = now - s.lastAlertAt > REALERT_MS;
        if (justDown || stale) {
          await alertAdmins(`🚨 *${r.name} is DOWN* — ${r.detail ?? "unreachable"}. The CRM may be degraded.`);
          s.lastAlertAt = now;
          logger.error(`Health alert: ${r.name} DOWN (${r.detail})`);
        }
        s.down = true;
      }
    } else {
      if (s.down) {
        await alertAdmins(`✅ *${r.name} recovered* — service is responding again.`);
        logger.info(`Health: ${r.name} recovered`);
      }
      s.down = false;
      s.fails = 0;
    }

    state.set(r.name, s);
  }

  return results;
}
