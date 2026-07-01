# Documentation changelog

Updated with every commit merged to `main`. Each entry: date, commit, what changed,
and which flow doc(s) were updated.

Format: newest first.

---

## 2026-07-01 — Sales-head escalation: CQS-extremes-only, off the rota

The sales head is a manager, not a line telecaller. New `SalesRep.salesHead` flag:
such reps are **excluded from the round-robin rota** (`pickNextRep`) so routine
handovers never route to them, and they're DM'd **only on CQS extremes** — a call
scoring ≥ `SALES_HEAD_CQS_HIGH` (default 90) or ≤ `SALES_HEAD_CQS_LOW` (default 15).
`notifySalesHead` (`lib/salesHead.ts`) fires from both scoring points — the AI
post-call path (`recordCall`) and the human callback path (`transcribeAndScoreCall`) —
independent of any handover. Anita Kishnani flagged `salesHead` in prod (rota is now
Fahar only). Schema: additive `SalesRep.salesHead`. New env: `SALES_HEAD_CQS_HIGH`,
`SALES_HEAD_CQS_LOW`. Updated [flow 5](flows/05-counsellor-and-manager-alerts.md).

## 2026-07-01 — Fix malformed TwiML on rep click-to-call (unescaped `&`)

The "who handled it" change added a `repId` query param to the recording-status
callback URL embedded in the dial TwiML, giving it a second param joined by a raw
`&`. Inside an XML attribute a bare `&` is invalid, so when the rep answered, Twilio
failed to parse the TwiML and played *"an application error has occurred"* instead of
dialing the lead. `dialLeadTwiML` now XML-escapes the callback URL (and caller id /
lead number) — `&` → `&amp;`. (The single-param URL before the repId feature had no
`&`, which is why the earlier button test passed.) File: `lib/providers/twilio.ts`.

## 2026-07-01 — Place outbound AI calls directly via ElevenLabs (drop n8n)

The outbound-call trigger routed through **n8n Agent 1** (`N8N_WEBHOOK_NEW_LEAD`), but
the n8n instance (`caraclinic.app.n8n.cloud`) went down — a `GET` on the webhook now
returns `404 No workspace here`. That silently killed every app-initiated call: the
lead saved, the phone never rang. (The same instance had already broken the *post-call*
webhook, which we bypassed earlier.) Both call sites — intake auto-call
(`lib/leadIntake.ts`) and worker retries/callbacks (`workers/callQueueWorker.ts`) —
now call `placeOutboundCall` (`lib/providers/elevenlabs.ts` →
`/v1/convai/twilio/outbound-call`) directly, removing the n8n dependency entirely. The
worker now fetches the lead's name/interest to pass as `dynamic_variables` (the old
n8n path re-fetched them server-side). Updated [flow 2](flows/02-ai-calling-and-retries.md).

## 2026-07-01 — Record who handled a human-handover call

Human-handover calls now capture the rep who took them. The initiating rep's id is
threaded through the Twilio callback URLs (clickToCall → voice TwiML →
recordingStatusCallback) and stored as `Call.handledById`. Shown as "👤 Handled by
<name>" on the lead-detail call list and a "Handled by" column on the Calls page
(AI calls show "🤖 AI"). Recording-webhook signature reconstruction switched to the
incoming path+query so the threaded `repId` is covered (verified). Schema: additive
`Call.handledById` → SalesRep.

## 2026-07-01 — Interactive Slack "Call & record" button

Handover Slack alerts now carry a "📞 Call & record" button. When a rep clicks it,
`/api/slack/interact` (Slack-signature verified) looks up the clicker's `SalesRep`
phone and fires `clickToCall` — Twilio rings the rep, then dials + records the lead.
Acks fast, reports back via `response_url`. New: `SLACK_SIGNING_SECRET`; needs
Interactivity enabled in the Slack app (Request URL `<base>/api/slack/interact`).
Files: `app/api/slack/interact/route.ts`, `lib/slack.ts` (verifySlackSignature),
`lib/handover.ts` (button). Updated flow 4.

## 2026-07-01 — Fix post-call webhook payload validation (live wiring)

The live ElevenLabs post-call webhook was returning 400 (schema reject) on real
payloads, so calls never reached `recordCall`. Two over-strict Zod constraints:

- data-collection `value` required a string, but real values can be boolean
  (`consultation_scheduled=false`) or null (`patient_name=null`);
- `dynamic_variables` required string values, but ElevenLabs injects numeric/boolean
  `system__*` variables (turns, duration, is_text_only).

Loosened both to `z.unknown()`; the mapper now coerces values via a `str()` helper.
Also repointed the workspace post-call webhook from the dead n8n URL to the CRM's
direct endpoint (`/api/webhooks/call-completed`) and set the matching signing secret.
Files: `lib/contracts.ts`, `lib/providers/elevenlabs.ts`.

## 2026-06-30 — ElevenLabs agent ↔ CRM integration contract

Aligned the AI first-call agent (the "First Call Rulebook") with the CRM. Added
[elevenlabs-agent-integration.md](elevenlabs-agent-integration.md): the exact
post-call data-collection fields the agent must emit (`outcome`, `sentiment`,
`callback_time`, `tag`, `language`, `handover_reasons`), the outcome→behaviour map,
the Rulebook §15 escalation → `handover_reasons` key mapping, the required
recording-consent disclosure, and the "WhatsApp is sent by the CRM" / "CQS is
computed by the CRM" clarifications.

Code: `HANDOVER_SUPPORTED_LANGUAGES` default changed `en,hi,mr` → `en,hi` to match
the rulebook (agent handles Hindi/English only; Marathi routes to a human).
Added gap F6 (no nurture/drip-only outcome state).

## 2026-06-30 — Gaps & roadmap backlog documented

Captured the full 2026-06-29 audit (security / reliability / compliance-ops) as
[gaps-and-roadmap.md](gaps-and-roadmap.md) — the single tracked backlog with
severity/status/file refs. Linked from the README. The three critical reliability
items are marked ✅ done (see entry below); everything else is ⬜ open.

## 2026-06-29 — Critical reliability fixes in the post-call pipeline

From the gap audit. Fixes the top reliability findings in `recordCall`:

- **Idempotency** — `Call.elevenlabsId` and `Call.providerSid` are now `@unique`;
  `recordCall` returns the existing call on a duplicate webhook (ElevenLabs/n8n/Twilio
  retries) instead of re-scoring, re-alerting, and re-scheduling. The Twilio recording
  webhook is idempotent on `CallSid` too.
- **Attempt-count bug** — the retry-ladder index now counts only AI call types, so a
  `human_handover` recording can't inflate it (which previously caused `NaN` delays or
  premature `unreachable`).
- **Atomic write** — the `Call` insert + `Lead` update run in one transaction;
  side-effects (queue/Slack/WhatsApp) are deferred until after commit.

Updated: [flow 2](flows/02-ai-calling-and-retries.md), [flow 3](flows/03-post-call-cqs-and-stage.md).
Schema change: `@unique` on `Call.elevenlabsId` + `Call.providerSid` (additive index).

## 2026-06-27 — Documentation module created

Initial flow-wise documentation covering the system as it stands in `main` after the
escalation/alerting build-out. Baseline captures these merged milestones:

- **`bdce2f0`** — System downtime / API-failure monitor → [flow 7](flows/07-system-health-monitor.md)
- **`bae6441`** — CQS transcription + hot-lead escalation + handover SLA + counsellor
  feed + daily digest → [flow 3](flows/03-post-call-cqs-and-stage.md),
  [flow 4](flows/04-handover-escalation-and-sla.md),
  [flow 5](flows/05-counsellor-and-manager-alerts.md)

Also documents the pre-existing foundation (lead intake, AI calling, WhatsApp) that
was built before the changelog began — see [flow 1](flows/01-lead-intake.md),
[flow 2](flows/02-ai-calling-and-retries.md), [flow 6](flows/06-whatsapp-messaging.md).

### Outstanding / known gaps recorded at baseline

- Live AI calling + human-call transcription gated on **ElevenLabs credits** (account at 0).
- **External uptime check** not yet set up (flow 7 limitation).
- Meta `leads_retrieval` App Review pending → FB/IG auto-call paused (flow 1).
- ElevenLabs agent not yet emitting handover reason data points (flow 4).
