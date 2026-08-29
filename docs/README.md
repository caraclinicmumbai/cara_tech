# Cara Clinic CRM — System Documentation

A sales-automation CRM for a hair-transplant & aesthetic clinic in Mumbai. It
captures leads from every channel, calls them with an AI voice agent, hands the
promising ones to human counsellors, keeps a unified WhatsApp thread per patient,
scores every call for quality, and watches itself for problems.

This documentation is organised **by flow** — the path a lead or an event takes
through the system — rather than by file. Each flow document states what triggers
it, the step-by-step path, the key files, the configuration, and (important) its
**known limitations**.

## How to read this

Start with [architecture.md](architecture.md) for the moving parts (services,
data model, integrations), then dip into the flow you care about.

## Flows

| # | Flow | What it covers |
|---|------|----------------|
| 1 | [Lead intake](flows/01-lead-intake.md) | Capturing leads from web form, Meta, Google, walk-in, WhatsApp; dedup, spam-hold, consent |
| 2 | [AI calling & retries](flows/02-ai-calling-and-retries.md) | Outbound AI calls, the attempt ladder, do-not-call window, callbacks |
| 3 | [Post-call processing, CQS & stage](flows/03-post-call-cqs-and-stage.md) | What happens when a call ends: status, stage, tag, quality score |
| 4 | [Handover, escalation & SLA](flows/04-handover-escalation-and-sla.md) | AI→human handover, hot-lead escalation, recorded call-back, 2h SLA |
| 5 | [Counsellor & manager alerts](flows/05-counsellor-and-manager-alerts.md) | Counsellor oversight feed, premature-lost, stuck-in-stage, daily digest |
| 6 | [WhatsApp messaging](flows/06-whatsapp-messaging.md) | Unified inbound/outbound thread, templates, media, automated outreach |
| 7 | [System health monitor](flows/07-system-health-monitor.md) | Downtime / API-failure alerts to admin + branch manager |
| 8 | [Follow-up campaigns](flows/08-follow-up-campaigns.md) | Automated nurture campaigns for leads that go quiet, and the guardrails that keep them from becoming harassment |
| 9 | [Post-sales journey / ERP](flows/09-post-sales-journey.md) | The clinical side: one journey per converted quote, per-treatment stage limits, coordinated day 1/7/30/90 care check-ins, handover summary |
| 10 | [Quote lifecycle](flows/10-quote-lifecycle.md) | The commercial track: raise → price → revise → send → accept → convert, the money maths, the Open Quotes desk, and what locks on conversion |
| 11 | [Inbound call routing](flows/11-inbound-call-routing.md) | Patients calling the published clinic number: sticky routing to their own counsellor, cover ladder, hold, voicemail |
| 12 | [Reports](flows/12-reports.md) | The ten management read-outs: inflow, AI contact, handoff speed, counsellors, cost per lead/consultation/surgery, lost leads, treatment mix, lost quotes, multi-quote, repeat treatment — and the ad-spend import behind the cost figures |

**Also:** [ElevenLabs agent ↔ CRM integration contract](elevenlabs-agent-integration.md) —
what the AI first-call agent must emit (outcome, handover keys, callback time, tag,
language) for the automation to fire correctly.

## Gaps & roadmap

The full known-gaps backlog (security, reliability, compliance, testing, ops) from
the 2026-06-29 audit lives in **[gaps-and-roadmap.md](gaps-and-roadmap.md)** — the
single tracked list, with severity, status, file references, and fix directions.

## Known limitations (index)

Each flow lists its own limitations; the cross-cutting ones worth knowing up front:

- **ElevenLabs credits gate live AI calls _and_ human-call transcription.** With the
  account at zero, the AI voice agent can't place calls and Scribe can't transcribe —
  both degrade gracefully but produce no output. See flows 2 and 3.
- **The health monitor runs inside the worker**, so it cannot detect total-platform
  downtime (worker down, Slack down). Pair it with an external uptime check. See flow 7.
- **TRAI DND compliance is not implemented** (no DLT-registered provider). The internal
  do-not-call _time window_ is enforced; statutory DND scrubbing is not. See flow 2.
- **Meta lead auto-calling is paused** for `facebook`/`instagram` pending App Review of
  `leads_retrieval` advanced access. See flow 1.
- **Inbound call routing is built but not live.** Production has no Twilio config and
  the website number isn't pointed at the webhook yet; the flow is verified against
  signed simulated requests only. A Twilio +91 number also needs India regulatory
  approval before it can receive calls. See flow 11.
- **Nothing expires a quote automatically.** `expiresAt` is stamped at creation and shown
  in the UI, but no sweep flips a lapsed quote to `expired` and the spec's 48h expiry
  nudge doesn't exist — a lapsed quote keeps counting as open until someone moves it by
  hand. See flow 10.
- **Post-sales care check-ins send nothing yet.** The engine, schedule and coordination are
  live, but the four WhatsApp templates aren't approved, so every check-in lands as a task
  for a person. `POSTSALES_CHECKINS_ENABLED` is also off by default. See flow 9.

## Maintenance convention

**This documentation is updated with every commit merged to `main`.** When a change
lands:

1. Update the affected flow document(s) — steps, files, config, and limitations.
2. Add a dated entry to [CHANGELOG.md](CHANGELOG.md) referencing the commit.

Keep statements grounded in the actual code; if behaviour and docs disagree, the code
wins and the docs are wrong — fix them.
