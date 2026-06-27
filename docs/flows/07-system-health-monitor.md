# Flow 7 — System health monitor

Watches the platform's critical dependencies and alerts the CRM admin + branch
manager on Slack the moment one goes down — and again when it recovers — so an outage
is known before users feel it.

## Trigger

A `setInterval` in the worker runs `monitorSystemHealth` (`lib/healthMonitor.ts`)
every `HEALTH_MONITOR_MINUTES` (default 5), plus once at boot.

## Step-by-step

1. **Probe each subsystem** (in parallel):
   - **Postgres** — `SELECT 1`
   - **Redis** — `PING`
   - **CRM web** — `GET {NEXTAUTH_URL}/login` (status < 500 = ok)
   - **WhatsApp API** — Graph `GET /{phoneId}` (gated on config)
   - **Twilio API** — `GET /Accounts/{sid}.json` (gated on config)
   - **Anthropic API** — `GET /v1/models` (unbilled; gated on config)

   ElevenLabs is intentionally left to its own credit-aware monitor
   (`lib/providers/elevenlabsHealth.ts`).
2. **Per-subsystem debounce.** A subsystem is declared down only after
   `HEALTH_FAIL_THRESHOLD` (default 2) **consecutive** failed probes — this rides out
   deploy restarts and momentary blips.
3. **Alert.** On confirmed down: alert the admins. While still down: re-alert at most
   every `HEALTH_REALERT_HOURS` (default 1). On the next good probe: send a ✅ recovery
   notice. State is in-memory (resets on worker restart — acceptable).
4. **Recipients.** `CRM_ADMIN_CHANNEL` **and** the branch-manager channel, deduped;
   both fall back to `SLACK_DEFAULT_CHANNEL`.

## Key files

- `lib/healthMonitor.ts` — probes, debounce state machine, alerting
- `workers/callQueueWorker.ts` — the interval

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `CRM_ADMIN_CHANNEL` | → default channel | Admin recipient for downtime alerts |
| `HEALTH_MONITOR_MINUTES` | `5` | Probe interval |
| `HEALTH_FAIL_THRESHOLD` | `2` | Consecutive failures before "down" |
| `HEALTH_REALERT_HOURS` | `1` | Re-alert cadence while down |
| `NEXTAUTH_URL` (worker) | — | Must be the prod web URL for the web probe to work |

## Limitations

- **It runs inside the worker**, so it structurally cannot report **total-platform
  downtime** — if the worker itself is down, or Slack is down, no alert fires. Pair it
  with an **external uptime check** (UptimeRobot / Better Uptime / Pingdom) on the prod
  `/login` URL. *(Follow-up: not yet set up.)*
- **The web probe needs `NEXTAUTH_URL` set on the worker** to the prod web URL;
  otherwise the CRM-web check is skipped (DB/Redis/API checks still run).
- **Debounce state is in-memory**, so a worker restart resets failure counters — a
  flapping dependency could re-alert after each restart.
- **External-API probes are shallow reachability/auth checks**, not deep functional
  tests; a partially-degraded API returning 200 won't be flagged.
