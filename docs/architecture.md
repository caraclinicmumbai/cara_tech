# Architecture

## Services (Railway)

| Service | Process | Responsibility |
|---------|---------|----------------|
| **web** | `next start` (Next.js 16) | Dashboard UI, API routes, webhooks, server actions. Runs `recordCall` for inbound post-call webhooks. |
| **worker** | `npm run worker` (`workers/callQueueWorker.ts`) | BullMQ consumers + periodic jobs: AI call attempts, handover-SLA checks, stuck-in-stage scan, daily digest, ElevenLabs monitor, system health monitor. |
| **Postgres** | Railway plugin | System of record (Prisma). |
| **Redis** | Railway plugin | BullMQ queues + rate-limit / throttle counters. |

Production web URL: `https://caratech-production.up.railway.app`. Deploys are
triggered automatically on push to `main` (both web and worker rebuild:
`prisma generate && next build`).

## Tech stack

- **Next.js 16** (App Router, React Server Components, Server Actions). Note: this
  build renames middleware to `proxy.ts`. Route gating + session live in `auth.ts`.
- **Auth.js v5** — credentials login (scrypt), JWT sessions, 12h max age. Every
  Server Action and API route re-checks the session.
- **Prisma v6 + PostgreSQL** — schema in `prisma/schema.prisma`. Schema changes are
  applied with `prisma db push` (no migration files). Additive columns are pushed to
  **prod first**, before the code that reads them deploys.
- **BullMQ + Redis** — delayed/repeatable jobs (`lib/queue.ts` and per-feature queues).
- **Winston** — logging (`lib/logger.ts`).

## External integrations

| Integration | Used for | Key module |
|-------------|----------|------------|
| **ElevenLabs** Conversational AI | Outbound AI voice calls + post-call webhook | `lib/providers/elevenlabs.ts` |
| **ElevenLabs** Scribe | Speech-to-text for recorded human calls | `lib/providers/elevenlabs.ts` (`transcribeAudio`) |
| **n8n** (cloud) | Orchestrates Agent 1 (place call) + Agent 2 (write-back) | `lib/n8n.ts`, `n8n/*.json` |
| **Twilio** | Recorded click-to-call for human handovers | `lib/providers/twilio.ts` |
| **WhatsApp Business Cloud API** (Meta) | Unified patient messaging thread | `lib/providers/whatsapp.ts`, `lib/messages.ts` |
| **Meta Lead Ads** (FB/IG) | Lead intake | `lib/providers/meta.ts` |
| **Google Lead Form** | Lead intake | `lib/providers/google.ts` |
| **Anthropic (Claude)** | Conversation Quality Score | `lib/cqs.ts` |
| **Slack** | All staff notifications | `lib/slack.ts` |

## Core data model (`prisma/schema.prisma`)

- **Lead** — the central record. Carries contact details, `source`, internal
  `status` (automation state), human-facing `stage` (pipeline), `tag`, attribution
  (`campaign`/`adId`/`externalId`), and flags for dedup, held-for-review, opt-out,
  consent, callbacks, handover, assignment, stage-age, and premature-lost.
- **Call** — one voice call (AI or human). Type, transcript, outcome, sentiment,
  duration, recording URL, and `cqs` + `cqsBreakdown`.
- **Message** — one WhatsApp message (inbound or outbound) — the unified thread.
- **SalesRep** — a counsellor/telecaller who receives handovers (round-robin).
- **User / Account / Session** — Auth.js.

### Two state fields, on purpose

`Lead.status` is the **internal automation state** (`new`, `manual_followup`,
`confirmed`, `rescheduled`, `unreachable`, `not_interested`, …). `Lead.stage` is the
**human-facing sales pipeline** (`fresh_inquiry` → … → `converted` / `lost`). They
move independently: the automation drives `status`; `stage` is auto-advanced
forward-only by call outcomes and freely editable by staff.

## Conventions

- Secrets live only in gitignored env files (`.env.local`, Railway dashboard);
  never committed.
- Notifications are **best-effort**: a Slack/DB/API failure in a notifier is logged
  and swallowed, never allowed to break the request that triggered it.
- All scheduled/time logic is computed in **IST (Asia/Kolkata)** regardless of server
  timezone (`lib/callWindow.ts`).
