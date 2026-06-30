# Documentation changelog

Updated with every commit merged to `main`. Each entry: date, commit, what changed,
and which flow doc(s) were updated.

Format: newest first.

---

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
