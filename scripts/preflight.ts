// Pre-demo / pre-shift preflight: is every dependency up, authenticated, and in
// credit? Read-only — it queries account and status endpoints only, never sends a
// message, places a call, or spends anything.
//
// Run: ./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/preflight.ts
import "dotenv/config";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import { isBackupConfigured, storageConfig, listObjects } from "@/lib/backup/storage";
import { isEncryptionEnabled } from "@/lib/backup/crypto";
import { chooseMode } from "@/lib/backup/dump";

const prisma = new PrismaClient();
const line = (icon: string, name: string, detail: string) => console.log(`${icon}  ${name.padEnd(22)} ${detail}`);
const OK = "✅";
const WARN = "⚠️ ";
const BAD = "❌";
const SKIP = "➖";

const money = (n: number, cur: string) => `${cur} ${n.toFixed(2)}`;
const pct = (used: number, limit: number) => (limit > 0 ? Math.round((used / limit) * 100) : 0);

async function database() {
  try {
    const [leads, reps, users] = await Promise.all([
      prisma.lead.count({ where: { deletedAt: null } }),
      prisma.salesRep.count({ where: { active: true } }),
      prisma.user.count(),
    ]);
    line(OK, "Database", `up — ${leads} leads, ${reps} active reps, ${users} logins`);
  } catch (err) {
    line(BAD, "Database", String(err).slice(0, 120));
  }
}

async function redisCheck() {
  const client = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 5_000,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    const queued = await client.keys("bull:*").then((k) => k.length);
    line(pong === "PONG" ? OK : WARN, "Redis", `${pong} — ${queued} queue key(s)`);
  } catch (err) {
    line(BAD, "Redis", String(err).slice(0, 120));
  } finally {
    client.disconnect();
  }
}

async function web(label: string, url: string | undefined) {
  if (!url) return line(SKIP, label, "no URL configured");
  try {
    const started = Date.now();
    const res = await axios.get(`${url.replace(/\/$/, "")}/login`, { timeout: 20_000, validateStatus: () => true });
    const ms = Date.now() - started;
    line(res.status < 500 ? OK : BAD, label, `HTTP ${res.status} in ${ms}ms — ${url}`);
  } catch (err) {
    line(BAD, label, axios.isAxiosError(err) ? err.message : String(err));
  }
}

async function elevenlabs() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return line(SKIP, "ElevenLabs", "no API key set");
  try {
    const res = await axios.get("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      return line(BAD, "ElevenLabs", `HTTP ${res.status}${res.status === 401 ? " — key rejected" : ""}`);
    }
    const d = res.data ?? {};
    const used = Number(d.character_count ?? 0);
    const limit = Number(d.character_limit ?? 0);
    const left = limit - used;
    const resets = d.next_character_count_reset_unix
      ? new Date(d.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)
      : "?";
    const icon = limit > 0 && pct(used, limit) >= 90 ? WARN : OK;
    line(
      icon,
      "ElevenLabs",
      `tier=${d.tier ?? "?"} status=${d.status ?? "?"} · ${left.toLocaleString()} of ${limit.toLocaleString()} chars left (${pct(used, limit)}% used) · resets ${resets}`,
    );
  } catch (err) {
    line(BAD, "ElevenLabs", axios.isAxiosError(err) ? err.message : String(err));
  }
}

async function elevenlabsAgent() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const phoneId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID;
  if (!key || !agentId) return line(SKIP, "ElevenLabs agent", "agent id not configured");
  try {
    const res = await axios.get(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      headers: { "xi-api-key": key },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (res.status !== 200) return line(BAD, "ElevenLabs agent", `HTTP ${res.status} for agent ${agentId}`);
    line(OK, "ElevenLabs agent", `"${res.data?.name ?? agentId}" reachable${phoneId ? ` · phone id set` : " · NO phone number id"}`);
  } catch (err) {
    line(BAD, "ElevenLabs agent", axios.isAxiosError(err) ? err.message : String(err));
  }
}

async function twilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return line(SKIP, "Twilio", "not configured");
  try {
    const auth = { username: sid, password: token };
    const acct = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { auth, timeout: 15_000, validateStatus: () => true });
    if (acct.status !== 200) return line(BAD, "Twilio", `HTTP ${acct.status}`);
    const bal = await axios.get(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, { auth, timeout: 15_000, validateStatus: () => true });
    const balance = Number(bal.data?.balance ?? NaN);
    const cur = bal.data?.currency ?? "USD";
    const type = acct.data?.type ?? "?"; // Trial | Full
    const icon = acct.data?.status !== "active" ? BAD : Number.isFinite(balance) && balance < 5 ? WARN : OK;
    line(icon, "Twilio", `${acct.data?.status} (${type}) · balance ${Number.isFinite(balance) ? money(balance, cur) : "?"} · caller ${process.env.TWILIO_CALLER_ID ?? "unset"}`);
    await callerIdRegion(auth);
  } catch (err) {
    line(BAD, "Twilio", axios.isAxiosError(err) ? err.message : String(err));
  }
}

/// Ask Twilio whether a number is one it will actually put on the wire.
///
/// A `<Dial callerId>` Twilio doesn't recognise is NOT an error you will notice. It
/// doesn't fail the call or raise an alert — Twilio quietly substitutes the parent
/// leg's From, so the patient sees the number that rang the counsellor, the
/// counsellor hears a perfectly normal call, and the CRM files a success. The only
/// place the truth appears is Twilio's own call log.
///
/// That silence is exactly how a caller ID that was "fixed" twice went on dialling
/// patients as +1 for six weeks. A number is usable only if we OWN it or it is a
/// VERIFIED caller ID, so ask the account rather than trusting the variable.
async function callerIdStatus(
  auth: { username: string; password: string },
  number: string,
): Promise<"owned" | "verified" | "unusable"> {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}`;
  const last10 = (n: string) => n.replace(/\D/g, "").slice(-10);
  const [owned, verified] = await Promise.all([
    axios.get(`${base}/IncomingPhoneNumbers.json?PageSize=100`, { auth, timeout: 15_000 }),
    axios.get(`${base}/OutgoingCallerIds.json?PageSize=100`, { auth, timeout: 15_000 }),
  ]);
  const match = (rows: { phone_number?: string }[] | undefined) =>
    (rows ?? []).some((r) => r.phone_number && last10(r.phone_number) === last10(number));
  if (match(owned.data?.incoming_phone_numbers)) return "owned";
  if (match(verified.data?.outgoing_caller_ids)) return "verified";
  return "unusable";
}

/// Warn when the outbound caller ID isn't an Indian number.
///
/// This isn't a misconfiguration Twilio will ever complain about — the calls connect
/// fine. It's that patients don't ANSWER them: a +1 number calling an Indian mobile
/// shows up as an unknown international caller and gets flagged as spam by Truecaller,
/// which most of the country runs. Observed in a test run where the same patients
/// answered an Indian dialler minutes later. Worth surfacing here because the symptom
/// ("nobody picks up") looks like a lead-quality problem, not a phone-number problem.
async function callerIdRegion(auth: { username: string; password: string }) {
  const caller = process.env.TWILIO_CALLER_ID?.trim();
  if (!caller) return line(WARN, "Caller ID", "TWILIO_CALLER_ID unset — click-to-call will fail");

  // Can Twilio even use it? This is the check that outranks every other line here:
  // a caller ID Twilio rejects doesn't break anything visibly, it just keeps showing
  // patients the old number.
  try {
    const patient = await callerIdStatus(auth, caller);
    if (patient === "unusable") {
      line(
        BAD,
        "Caller ID on Twilio",
        `${caller} is NEITHER a number on this account NOR a verified caller ID — Twilio will ` +
          `silently ignore it and dial patients from the number that rings the counsellor instead. ` +
          `Verify it (Console → Phone Numbers → Manage → Verified Caller IDs) or buy an Indian number.`,
      );
    } else {
      line(
        OK,
        "Caller ID on Twilio",
        `${caller} is ${patient === "owned" ? "a number this account owns" : "a verified caller ID"} — Twilio will use it`,
      );
    }

    // The rep leg is a REST `From`, which Twilio validates strictly (error 21210) —
    // an unusable value fails the call outright rather than degrading quietly.
    const repFrom = process.env.TWILIO_REP_CALLER_ID?.trim() || process.env.TWILIO_OWNED_NUMBER?.trim();
    if (repFrom && (await callerIdStatus(auth, repFrom)) === "unusable") {
      line(BAD, "Rep caller ID", `${repFrom} isn't owned or verified — Twilio will reject the leg that rings the counsellor.`);
    }
  } catch (err) {
    line(WARN, "Caller ID on Twilio", `could not verify: ${axios.isAxiosError(err) ? err.message : String(err)}`);
  }

  // The patient-facing caller ID must not be a counsellor's own handset: a
  // click-to-call rings the counsellor first, and Twilio refuses From == To. The
  // symptom is that calling breaks for exactly one member of staff, which is
  // miserable to attribute — so it's checked here instead.
  const last10 = (n: string) => n.replace(/\D/g, "").slice(-10);
  const reps = await prisma.salesRep.findMany({
    where: { active: true },
    select: { name: true, phone: true },
  });
  const clash = reps.find((r) => r.phone && last10(r.phone) === last10(caller));
  if (clash) {
    const repFrom = process.env.TWILIO_REP_CALLER_ID?.trim() || process.env.TWILIO_OWNED_NUMBER?.trim();
    if (repFrom && last10(repFrom) !== last10(caller)) {
      line(OK, "Rep leg", `rings counsellors from ${repFrom} — avoids From == To with ${clash.name}'s phone`);
    } else {
      line(
        BAD,
        "Caller ID clash",
        `${caller} is ${clash.name}'s own phone. A click-to-call rings the counsellor first, so ` +
          `Twilio will reject From == To and calling will fail FOR THAT COUNSELLOR ONLY. ` +
          `Set TWILIO_REP_CALLER_ID (or TWILIO_OWNED_NUMBER) to a Twilio number you own.`,
      );
    }
  }

  if (caller.startsWith("+91")) return line(OK, "Caller ID", `${caller} — Indian number`);
  line(
    WARN,
    "Caller ID",
    `${caller} is not an Indian (+91) number. Patients in India rarely answer foreign ` +
      `numbers and Truecaller flags them as spam — expect very low answer rates. ` +
      `See docs/deferred-todo.md ("Indian caller ID").`,
  );
}

async function whatsapp() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const waba = process.env.WHATSAPP_WABA_ID;
  const ver = process.env.META_GRAPH_VERSION ?? "v21.0";
  if (!token || !phoneId) return line(SKIP, "WhatsApp", "not configured");
  try {
    const num = await axios.get(`https://graph.facebook.com/${ver}/${phoneId}`, {
      params: { fields: "display_phone_number,verified_name,quality_rating,throughput,webhook_configuration" },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (num.status !== 200) {
      const msg = num.data?.error?.message ?? `HTTP ${num.status}`;
      return line(BAD, "WhatsApp", `${msg}`);
    }
    const d = num.data ?? {};
    line(OK, "WhatsApp number", `${d.display_phone_number} (${d.verified_name}) · quality ${d.quality_rating ?? "?"}`);

    // WHERE inbound replies are delivered. Meta holds one callback URL per number,
    // so if it points at another deployment, this environment sends fine and never
    // receives — the thread looks one-sided and the 24h window never opens.
    const hook = num.data?.webhook_configuration?.application as string | undefined;
    const mine = (process.env.WHATSAPP_PUBLIC_BASE ?? process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
    if (!hook) {
      line(WARN, "WhatsApp webhook", "no callback URL set on the number — inbound replies go nowhere");
    } else if (mine && hook.startsWith(mine)) {
      line(OK, "WhatsApp webhook", hook);
    } else {
      line(WARN, "WhatsApp webhook", `points at ${hook} — replies land THERE, not in this environment`);
    }

    if (waba) {
      const tpl = await axios.get(`https://graph.facebook.com/${ver}/${waba}/message_templates`, {
        params: { fields: "name,status", limit: 200 },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
        validateStatus: () => true,
      });
      if (tpl.status !== 200) return line(WARN, "WhatsApp templates", `HTTP ${tpl.status}`);
      const rows: { name: string; status: string }[] = tpl.data?.data ?? [];
      const approved = rows.filter((t) => t.status === "APPROVED");
      const other = rows.filter((t) => t.status !== "APPROVED");
      line(approved.length ? OK : WARN, "WhatsApp templates", `${approved.length} approved${other.length ? `, ${other.length} not (${other.map((t) => `${t.name}:${t.status}`).join(", ")})` : ""}`);
    }
  } catch (err) {
    line(BAD, "WhatsApp", axios.isAxiosError(err) ? err.message : String(err));
  }
}

async function anthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return line(SKIP, "Anthropic", "no API key set");
  try {
    const res = await axios.get("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (res.status === 200) return line(OK, "Anthropic", `key valid · ${res.data?.data?.length ?? "?"} models visible`);
    line(BAD, "Anthropic", res.status === 401 ? "401 — key rejected" : `HTTP ${res.status}`);
  } catch (err) {
    line(BAD, "Anthropic", axios.isAxiosError(err) ? err.message : String(err));
  }
}

async function slack() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return line(SKIP, "Slack", "no bot token (in-app notifications only)");
  try {
    const res = await axios.post("https://slack.com/api/auth.test", null, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (res.data?.ok) return line(OK, "Slack", `${res.data.team} as ${res.data.user}`);
    line(WARN, "Slack", `auth.test: ${res.data?.error ?? res.status}`);
  } catch (err) {
    line(WARN, "Slack", axios.isAxiosError(err) ? err.message : String(err));
  }
}

/// Backups (§backups). Deliberately noisy: this is the check whose failure nobody
/// notices until the day it matters, so "off" reads as ❌ rather than a skip.
async function backups() {
  if (!isBackupConfigured()) {
    line(BAD, "Backups", "OFF — BACKUP_S3_* unset, nothing is copied off Railway");
    return;
  }
  const cfg = storageConfig()!;
  const { mode, reason } = await chooseMode();
  line(
    mode === "pg_dump" ? OK : WARN,
    "Backup dump mode",
    mode === "pg_dump" ? reason : `portable fallback — ${reason}`,
  );
  line(
    isEncryptionEnabled() ? OK : WARN,
    "Backup encryption",
    isEncryptionEnabled() ? "on (AES-256-GCM)" : "OFF — patient data would sit in the bucket in the clear",
  );

  // Freshness beats configuration: a bucket that is set up and has nothing recent in
  // it is the failure this whole check exists to catch.
  try {
    const daily = await listObjects(cfg, `${cfg.prefix}/daily/`);
    if (daily.length === 0) {
      line(BAD, "Backup freshness", "the bucket is configured but EMPTY — no backup has ever run");
      return;
    }
    const newest = daily.reduce((a, b) => (a.modified > b.modified ? a : b));
    const hours = (Date.now() - newest.modified.getTime()) / 3_600_000;
    const weekly = await listObjects(cfg, `${cfg.prefix}/weekly/`);
    const monthly = await listObjects(cfg, `${cfg.prefix}/monthly/`);
    line(
      hours < 26 ? OK : BAD,
      "Backup freshness",
      `newest ${newest.key.split("/").pop()} — ${hours < 1 ? "under an hour" : `${Math.round(hours)}h`} old` +
        ` · ${daily.length} daily / ${weekly.length} weekly / ${monthly.length} monthly`,
    );
  } catch (err) {
    line(BAD, "Backup bucket", `unreachable — ${String(err).slice(0, 90)}`);
  }
}

async function readiness() {
  // The data-side things that make a demo look broken even when every API is up.
  const [ownerless, unlinkedReps, undialable] = await Promise.all([
    prisma.lead.count({ where: { assignedRepId: null, deletedAt: null } }),
    prisma.salesRep.findMany({ where: { active: true, user: null }, select: { name: true } }),
    prisma.lead.findMany({ where: { deletedAt: null }, select: { phone: true } }),
  ]);
  const bad = undialable.filter((l) => !/^\+\d{8,}$/.test(l.phone)).length;
  line(ownerless === 0 ? OK : WARN, "Lead ownership", ownerless === 0 ? "every lead has a counsellor" : `${ownerless} lead(s) with no counsellor`);
  line(
    unlinkedReps.length === 0 ? OK : WARN,
    "Rep logins",
    unlinkedReps.length === 0 ? "every active rep has a login" : `no login for: ${unlinkedReps.map((r) => r.name).join(", ")} (no bell / no "my leads")`,
  );
  line(bad === 0 ? OK : WARN, "Phone formats", bad === 0 ? "all leads E.164" : `${bad} lead(s) not E.164 — run scripts/normalizePhones.ts`);
}

async function main() {
  console.log(`\nCara preflight — ${new Date().toISOString()}\n${"─".repeat(78)}`);
  await database();
  await redisCheck();
  await web("CRM web (local)", process.env.NEXTAUTH_URL);
  await web("CRM web (prod)", process.env.PROD_BASE_URL ?? "https://caratech-production.up.railway.app");
  console.log("");
  await elevenlabs();
  await elevenlabsAgent();
  await twilio();
  await whatsapp();
  await anthropic();
  await slack();
  console.log("");
  await backups();
  console.log("");
  await readiness();
  console.log("─".repeat(78));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
