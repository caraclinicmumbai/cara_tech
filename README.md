# Cara Clinic — Sales Automation Platform

Internal sales-automation CRM. When a lead is created, an AI voice agent
(ElevenLabs) calls them, the call data is written back to the CRM, and a
re-confirmation call is scheduled a few days later — all automatically.

Built per the **Tech Stack & Build Guide v1.0**.

## Stack

| Layer        | Tech                                   |
| ------------ | -------------------------------------- |
| Frontend/API | Next.js 16 (App Router, TypeScript)    |
| Database     | PostgreSQL + Prisma ORM (v6)           |
| Job queue    | BullMQ + Redis (re-confirmation timer) |
| Auth         | NextAuth.js / Auth.js v5               |
| Automation   | n8n (self-hosted)                      |
| Voice        | ElevenLabs                             |
| Host         | Hostinger VPS (PM2 + Nginx)            |

## The automated flow

1. **Lead created** (`POST /api/leads` or `/api/webhooks/lead-created`) → stored in Postgres.
2. **n8n Agent 1** is fired (`lib/n8n.ts`) → formats payload → calls ElevenLabs.
3. **ElevenLabs** places the AI voice call.
4. **Post-call callback** → n8n Agent 2 → `POST /api/calls` writes the `Call` + updates `Lead.status`.
5. **BullMQ** schedules a delayed re-confirmation job (`lib/queue.ts`).
6. On fire, **`workers/callQueueWorker.ts`** re-triggers n8n Agent 1 with prior-call context.
7. Final outcome written; lead moves to `confirmed` / `rescheduled` / `lost`.

## Project layout

```
app/
  (dashboard)/        leads, calls, settings UI
  api/
    leads/route.ts          Lead CRUD (POST also fires n8n Agent 1)
    calls/route.ts          Call write-back (from n8n Agent 2)
    webhooks/
      lead-created/route.ts   External lead intake → fires n8n
      call-completed/route.ts ElevenLabs post-call callback
    auth/[...nextauth]/route.ts
lib/        prisma, redis, queue, n8n, contracts (Zod), logger, password, verify
workers/    callQueueWorker.ts   (BullMQ worker — run with PM2)
prisma/     schema.prisma, seed.ts
auth.ts     NextAuth/Auth.js v5 config
```

## Local setup

```bash
# 1. Services (Postgres, Redis, n8n) — needs Docker
docker compose up -d

# 2. Env
cp .env.example .env.local   # already present; edit secrets

# 3. Database
npm run db:push        # apply schema (or: npm run db:migrate)
npm run db:seed        # creates admin@caraclinic.com / changeme123

# 4. Run
npm run dev            # Next.js on :3000
npm run worker:dev     # BullMQ re-confirmation worker
```

Open http://localhost:3000 → redirects to `/leads`.

## Lead sources (intake)

Every source normalises to a `Lead` via `lib/leadIntake.ts` → `ingestLead()`, which
dedupes on `(source, externalId)` and fires the initial AI call. Adapters live in
`lib/providers/`.

| Source | Endpoint | Auth | Notes |
| ------ | -------- | ---- | ----- |
| **Website form** | `POST /api/intake/web-form` | public + honeypot (`company` field) + `WEB_FORM_ALLOWED_ORIGINS` | `{ name, phone, email?, interest? }` |
| **Facebook / Instagram** (Meta Lead Ads) | `GET` (verify) + `POST /api/intake/meta` | `hub.verify_token` + `X-Hub-Signature-256` (HMAC, `META_APP_SECRET`) | POST has only `leadgen_id`; full lead fetched from Graph API with `META_PAGE_ACCESS_TOKEN`. `platform` decides facebook vs instagram. |
| **Google Ads Lead Form** | `POST /api/intake/google` | `google_key` in body == `GOOGLE_LEADFORM_KEY` | maps `user_column_data` (`FULL_NAME`/`PHONE_NUMBER`/`EMAIL`). `is_test` pings are acknowledged, not stored. |
| Manual / internal | `POST /api/leads` | (dashboard) | also used by the create-lead form |
| Generic (n8n etc.) | `POST /api/webhooks/lead-created` | `x-webhook-secret` | normalised `{ name, phone, source?, ... }` |

Ad-webhook deliveries are **idempotent**: a repeat with the same `externalId`
returns the existing lead (`deduped: true`) and does not re-call.

**Meta setup:** in the Meta app, set the webhook callback to `…/api/intake/meta`,
verify token = `META_VERIFY_TOKEN`, subscribe to the `leadgen` field, and provide a
Page access token.
**Google setup:** in the lead form's *Webhook integration*, set the URL to
`…/api/intake/google` and Key = `GOOGLE_LEADFORM_KEY`.

## Call flow (n8n + ElevenLabs)

Importable workflows + setup live in [`n8n/`](n8n/README.md). Summary:

1. CRM fires `N8N_WEBHOOK_NEW_LEAD` → **Agent 1** → ElevenLabs outbound-call API.
   We pass `lead_id` + `call_type` as ElevenLabs `dynamic_variables` so they
   round-trip in the post-call payload.
2. After the call, ElevenLabs' post-call webhook → **Agent 2** → `POST /api/calls`.
   *(Or point ElevenLabs straight at `/api/webhooks/call-completed`, which verifies
   the `ElevenLabs-Signature` HMAC.)*
3. Both call-write paths run the same `recordCall()` ([lib/callIntake.ts](lib/callIntake.ts)):
   store the `Call`, update `Lead.status`, and schedule the re-confirmation after an initial call.

The ElevenLabs request shaping, signature verification, and post-call field
mapping are in [lib/providers/elevenlabs.ts](lib/providers/elevenlabs.ts).
`outcome`/`sentiment` come from the agent's configured **data collection** items
(falling back to `call_successful`).

### Call webhook contracts

- `POST /api/webhooks/call-completed` — raw ElevenLabs `post_call_transcription` shape; auth = `ElevenLabs-Signature` HMAC.
- `POST /api/calls` — n8n Agent 2 write-back `{ leadId, callType, elevenlabsId?, transcript?, outcome?, sentiment?, duration? }`; auth = `x-webhook-secret`.

## Production (Hostinger VPS)

```bash
npm run build
pm2 start ecosystem.config.js   # cara-crm + call-queue-worker
pm2 save && pm2 startup
```

Nginx reverse-proxies :3000 (app) and :5678 (n8n) with SSL. See Guide §3.

## Build phases

Phase 1 (this scaffold): CRM + schema + lead CRUD UI + automation plumbing.
Phases 2–5: n8n/ElevenLabs wiring, callbacks, BullMQ go-live, dashboard analytics.
