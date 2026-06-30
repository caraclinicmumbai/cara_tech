# ElevenLabs Agent ↔ CRM Integration Contract

The Cara AI first-call agent (the "First Call Rulebook") runs on ElevenLabs. This
document is the **contract** between that agent and the CRM: what the CRM sends the
agent, and — critically — what the agent must emit at call end so the automation
(stage advance, retries, callbacks, handover, tag, WhatsApp) fires correctly.

Source of the mapping: `lib/providers/elevenlabs.ts` (`mapElevenLabsPostCall`) and
`lib/callIntake.ts` (`recordCall`). If you change one, update the other and this doc.

---

## 1. Inbound — dynamic variables (CRM → agent)

When the CRM places the call (n8n Agent 1 → ElevenLabs), it passes these
`dynamic_variables`. They round-trip back in the post-call webhook so the result is
correlated to the lead — and they're available in the agent prompt for
personalisation:

| Variable | Use in prompt |
|----------|---------------|
| `lead_name` | Greet the patient by name |
| `call_type` | `initial` or `reconfirmation` — a reconfirmation call should reference prior context, not re-introduce |
| `interest` | What they enquired about (from the form) |
| `prior_context` | Summary of the previous call (reconfirmation only) |
| `lead_id` | Internal correlation — do not speak it |

## 2. Outbound — data the agent MUST emit (agent → CRM)

Set these as **data-collection fields** on the ElevenLabs agent. Field names must
match exactly (the CRM reads these keys).

| Field | Allowed values | Drives in the CRM |
|-------|----------------|-------------------|
| `outcome` | `confirmed` · `rescheduled` · `not_interested` · `no_answer` | Lead status, pipeline stage, retry ladder (see §3) |
| `sentiment` | `positive` · `neutral` · `negative` | Stored on the call |
| `callback_time` | ISO-8601 **with IST offset**, e.g. `2026-07-01T18:00:00+05:30` | Schedules the callback when `outcome=rescheduled` |
| `tag` | free text — what they asked for | `Lead.tag` (also accepts `requested_service` / `service` / `interest`) |
| `language` | `en` · `hi` · or the actual language if other | Unsupported language → human handover (see §5) |
| `handover_reasons` | comma-separated keys (see §4) | Routes the lead to a human + Slack alert |

> **Do NOT emit a `cqs` field.** The CRM computes the Conversation Quality Score
> itself (Claude scores the transcript). Anything the agent emits is ignored in
> favour of the computed score. See §6.

## 3. Outcome → what the CRM does

| `outcome` | CRM behaviour |
|-----------|---------------|
| `confirmed` | Status → `confirmed`, stage → `appointment_scheduled`; **confirmation WhatsApp auto-sent**; retry ladder stopped. Use when an appointment/consult is booked. |
| `rescheduled` | Schedules a single callback at `callback_time` (or, if none given, **7 PM IST next day**); **callback WhatsApp auto-sent**; retry ladder replaced. Use for "call me later" / warm follow-up. |
| `not_interested` | **HARD opt-out** — suppresses ALL future outreach including the WhatsApp drip. Use ONLY for a genuine "don't contact me / not interested at all." |
| `no_answer` (or none) | Treated as unanswered → retry ladder fires (next attempt +1 day, then +5 days), then `unreachable` + unreachable WhatsApp. Use only when nobody actually engaged. |

> ⚠️ **Cold-but-receptive ≠ `not_interested`.** A lead who's "not now but OK to
> receive info" must NOT be marked `not_interested` (that kills the content drip).
> Until a dedicated nurture state exists, mark them `outcome=rescheduled` with a
> longer-dated `callback_time` (e.g. 7–14 days) and `tag` prefixed `NURTURE`.
> (Tracked in [gaps-and-roadmap.md](gaps-and-roadmap.md).)

## 4. Handover reason keys (Rulebook §15 escalation → emit these)

Emit any that apply in `handover_reasons` (comma-separated), e.g.
`handover_reasons = "wants_human, price_request"`. The CRM stops the AI drip,
round-robin-assigns a counsellor, DMs them on Slack, and starts the 2h SLA.

| Rulebook escalation trigger | `handover_reasons` key |
|-----------------------------|------------------------|
| Patient asks for a human | `wants_human` |
| Clinical question the agent can't answer | `clinical_question` |
| Significant emotional distress | `emotional_distress` |
| Angry about a previous clinic experience | `emotional_distress` (or `unresolved_objection`) |
| Mentions a competitor / wants comparison | `competitor_mention` |
| Negotiates / pushes hard on price | `price_request` |
| Medically urgent (sudden extreme loss, scalp condition) | `clinical_question` |
| Abusive / inappropriate | `abusive` |
| Wrong person / landline answered by someone else | `wrong_person_landline` |
| International patient (needs the international protocol) | `wants_human` |
| Regional language, can't switch to Hindi/English | set `language` (see §5) — handled automatically |

> The CRM adds two more triggers **on its own**, so the agent need not emit them:
> `high_cqs` (computed CQS ≥ 75 → fast-track) and `unsupported_language` (derived
> from the `language` field vs the supported set).

## 5. Language

The agent handles **Hindi/Hinglish and English only** (Rulebook §2, Commandment #4).
For any other language the agent should request a switch and, failing that, set the
`language` field to the actual language (e.g. `marathi`, `gujarati`). The CRM then
fires the `unsupported_language` handover automatically.

For this to work, the CRM's supported set must match the rulebook:

```
HANDOVER_SUPPORTED_LANGUAGES = "en,hi"
```

(Code default updated to `en,hi`. If the Railway env var is set explicitly, update
it there too. Marathi is intentionally **not** supported by the AI agent — it routes
to a human.)

## 6. CQS — computed by the CRM, not the agent

Every call is scored 0–100 by Claude against a 6-dimension rubric (intent,
engagement, urgency, objection, **consent & compliance**, escalation). The agent
doesn't score itself, but its behaviour drives the score. To score well — and to
stay compliant — the agent must:

- **Announce call recording** at the top (see §7) — the consent dimension rewards this.
- **Never quote a final treatment cost** or make clinical commitments (anchor to
  per-session/entry price only).
- **Capture urgency** and **resolve/triage objections** rather than leaving them open.
- **Escalate appropriately** (emit the right `handover_reasons`).

A computed CQS ≥ 75 auto-escalates the lead to a counsellor as a hot lead.

## 7. Recording-consent disclosure (required)

Add to the agent's **opening** (Rulebook §4), after the greeting and before
qualification:

> *"Sir/Ma'am, ek choti si baat — quality aur training ke liye yeh call record ho rahi hai. Aapko theek hai na?"*

This satisfies the DPDP recording-consent requirement and the CQS consent dimension.
If the patient declines recording, emit `handover_reasons = "wants_human"` and hand
off rather than continuing on a recorded line.

## 8. WhatsApp is sent by the CRM

The agent should still say "I'll send the details on WhatsApp", but the **CRM
sends** the templates automatically on `confirmed` / `unreachable` / `callback`
(`lib/outreach.ts`) — the agent does not send them itself. These fire only once the
corresponding WhatsApp templates are approved and their env names set.

## 9. Call-window note

The CRM only dials between **10:00–22:00 IST** (do-not-call window). The Rulebook's
late-night "Namaste (9 PM–4:59 AM)" greeting row therefore rarely applies to
automated calls; keep it for manual use.
