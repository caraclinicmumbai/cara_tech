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

## 10. How to configure this in ElevenLabs (step-by-step)

All the §2 fields are set up as **Data Collection** items on the agent. ElevenLabs
extracts them from the transcript after the call and includes them in the post-call
webhook — which is exactly what the CRM reads.

**Where:** ElevenLabs → Conversational AI → your agent → **Analysis** tab →
**Data collection** → **Add item** (one per field below).

For each item set: **Identifier** (must match exactly), **Data type** = `String`,
and paste the **Description** (the extraction instruction).

### `outcome` — String
```
The single outcome of this call. Return exactly ONE keyword:
- confirmed — the patient booked or agreed to a consultation/appointment.
- rescheduled — the patient wants a callback later, asked to follow up, or is warm
  but not booking yet. Also use this for nurture/"send me info" leads.
- not_interested — the patient explicitly does NOT want to be contacted / is not
  interested at all (a hard opt-out). Use ONLY for a genuine opt-out.
- no_answer — nobody actually engaged (voicemail, wrong number, no conversation).
If unsure between rescheduled and not_interested, choose rescheduled. Output only the keyword.
```

### `sentiment` — String
```
The patient's overall sentiment. Return exactly one of: positive, neutral, negative.
```

### `callback_time` — String
```
If the patient agreed to a specific callback time, return it as an ISO-8601 datetime
WITH the IST offset, e.g. 2026-07-01T18:00:00+05:30. Resolve relative phrases
("kal subah 11 baje", "aaj shaam 6 baje") to an absolute IST datetime based on the
call time. If no specific time was agreed, return an empty string.
```

### `tag` — String
```
A short label of what the patient wants, for the CRM. Examples: "Hair transplant",
"PRP / thinning", "Female hair loss", "Beard transplant", "Eyebrow transplant",
"Rhinoplasty", "Skin / aesthetic", "Product enquiry". If the lead is early-stage /
not ready, prefix with "NURTURE - ". Keep it under ~60 characters.
```

### `language` — String
```
The main language the patient spoke. Return "en" for English, "hi" for
Hindi/Hinglish. If they primarily spoke another language and could not switch to
Hindi/English, return that language name in lowercase (e.g. "marathi", "gujarati",
"tamil"). Output only the code or single word.
```

### `handover_reasons` — String  (the §4 escalation mapping)
```
A comma-separated list of reasons to hand this lead to a human, using ONLY these
keys (return an empty string if none apply):
- wants_human — asked for a human/doctor, OR is an international patient.
- clinical_question — asked a clinical question the agent couldn't answer, or sounded
  medically urgent (sudden extreme hair loss, scalp condition).
- emotional_distress — significant emotional distress, or angry about a previous clinic.
- competitor_mention — mentioned a competitor or wanted a comparison.
- price_request — negotiated or pushed hard on price.
- abusive — abusive or inappropriate.
- wrong_person_landline — wrong person answered / a landline answered by someone else.
Example output: "wants_human, price_request". Do NOT invent any other keys.
```

> **Boolean alternative:** instead of the single `handover_reasons` string you may
> create individual **Boolean** items named `asked_price`, `clinical_question`,
> `emotional_distress`, `wants_human`, `competitor_mention`, `unresolved_objection`,
> `abusive`, `wrong_person_landline` — the CRM reads either form. The single string
> is simpler to maintain.

### Verify
1. Ensure the agent's **post-call webhook** is enabled and points at
   `…/api/webhooks/call-completed` (it already is in prod).
2. Place a test call, then check the webhook payload has
   `analysis.data_collection_results` populated with these keys — or just confirm the
   lead in the CRM shows the right stage/tag/handover after the call.

## 9. Call-window note

The CRM only dials between **10:00–22:00 IST** (do-not-call window). The Rulebook's
late-night "Namaste (9 PM–4:59 AM)" greeting row therefore rarely applies to
automated calls; keep it for manual use.

## 11. Voicemail detection (enabled — ends the call)

The agent's **`voicemail_detection`** system tool is enabled (agent config
`conversation_config.agent.prompt.built_in_tools.voicemail_detection`, params
`{ system_tool_type: "voicemail_detection", voicemail_message: "" }`). An empty
`voicemail_message` means: on detecting an answering machine / voicemail greeting, the
agent **ends the call immediately** rather than leaving a message or talking to dead
air. This is a cost + correctness guard — before it was enabled, a machine-answered
call (e.g. lead "Faiz") kept the agent monologuing to silence for ~2 minutes.
Configured via `PATCH /v1/convai/agents/{id}` (not in this repo — it's ElevenLabs-side
agent state; re-apply there if the agent is recreated).
