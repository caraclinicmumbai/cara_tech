# Flow 3 — Post-call processing, CQS & stage

The single pipeline that runs when any call ends. It records the call, scores its
quality, advances the pipeline, and decides what happens next.

## Trigger

A completed call arrives via one of:

- **n8n Agent 2 write-back** → `POST /api/calls` (x-webhook-secret gated)
- **ElevenLabs post-call webhook** → `POST /api/webhooks/call-completed` (HMAC verified)

Both funnel into **`recordCall` (`lib/callIntake.ts`)**.

## Step-by-step (`recordCall`)

0. **Idempotency + atomicity.** A duplicate webhook (ElevenLabs/n8n retry on
   timeout/5xx) is detected by the unique `Call.elevenlabsId` and returns the
   existing call without re-processing. The `Call` insert and the `Lead` update run
   in a single transaction, and all side-effects (queue scheduling, Slack, WhatsApp)
   are deferred until **after** commit — so a rollback leaves no orphaned jobs and a
   mid-pipeline crash can't leave a Call recorded with the Lead un-advanced.
1. **Conversation Quality Score.** `scoreCQS` (`lib/cqs.ts`) sends the transcript to
   Claude, which scores six dimensions; a weighted sum gives a 0–100 `cqs`. Stored with
   the call as `cqs` + `cqsBreakdown`. Best-effort — null when unconfigured/empty/failed,
   never blocks intake. (See "CQS rubric" below.)
2. **Persist the `Call`** (type, transcript, outcome, sentiment, duration, cqs).
3. **Stage auto-advance (forward-only).** `stageFromOutcome` maps the outcome to a stage
   (`confirmed`→`appointment_scheduled`, `rescheduled`→`in_consideration`,
   `no_answer`→`communication_not_established`); `advanceStage` applies it only if it
   moves the lead **forward** (never regresses a stage staff already set). On a real
   move, `stageChangedAt` is reset and `stageStuckNotifiedAt` cleared (feeds flow 5's
   stuck-in-stage SLA).
4. **Tag.** What the lead asked for (AI-extracted) is written to `Lead.tag` if present.
5. **Branch on outcome:**
   - **`not_interested`** → opt-out: suppress all outreach, cancel pending jobs.
   - **handover fired** (see flow 4) → route to sales, stop the drip, alert.
   - **`rescheduled` / callback** → schedule the callback (flow 2).
   - **unanswered** → schedule the next attempt, or mark `unreachable` if exhausted.
6. **Automated WhatsApp outreach (flow 6)** — confirmed / unreachable / callback
   templates fire (each off unless its template env is set), skipped if opted out.

## CQS rubric (`lib/cqs.ts`)

| Dimension | Weight |
|-----------|--------|
| Intent clarity | 20% |
| Engagement level | 20% |
| Urgency signal | 15% |
| Objection handling | 15% |
| Consent & compliance | 20% |
| Escalation handling | 10% |

A CQS ≥ `HANDOVER_CQS_THRESHOLD` (75) also drives the hot-lead escalation in flow 4.
For **human** handover calls there is no transcript at call time — flow 4's recorded
call is transcribed later (flow in [03a](#human-call-scoring)) and scored then.

### Human-call scoring

A recorded human-handover call (flow 4) has no transcript until **ElevenLabs Scribe**
transcribes the recording (`lib/callTranscription.ts`): download recording →
`transcribeAudio` → `scoreCQS` → write `transcript`/`cqs`/`cqsBreakdown` back onto the
call. Runs in the background from the Twilio recording webhook so the webhook returns
fast.

## Key files

- `lib/callIntake.ts` — `recordCall` (the pipeline)
- `lib/cqs.ts` — CQS scoring (Claude structured output)
- `lib/leadStages.ts` — stage keys, ranks, `advanceStage`, `stageFromOutcome`
- `lib/callTranscription.ts` — human-call transcription → CQS
- `app/(dashboard)/cqs/page.tsx` — CQS analytics dashboard

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | — | Enables CQS scoring (web service runs `recordCall`) |
| `CQS_MODEL` | `claude-opus-4-8` | Model used to judge calls |
| `ELEVENLABS_STT_MODEL` | `scribe_v1` | Scribe model for human-call transcription |

## Limitations

- **CQS needs Anthropic credits.** The key is set and scoring is verified working;
  with no credit balance it degrades to null (no score).
- **Human-call CQS needs ElevenLabs credits** for Scribe; with the account at zero,
  transcription returns null and the call is stored without a score.
- **CQS is a single-model judgement**, not calibrated against human review; treat the
  score as a triage signal, not ground truth.
- **Stage auto-advance never reaches `consultation_done`, `existing_followup`,
  `converted*`, or `lost`** — those are staff-only transitions.
- **Residual crash window:** the DB write is atomic, but the post-commit side-effects
  (scheduling the next retry, Slack) are not in the transaction. A crash in the
  millisecond between commit and scheduling could drop a retry job; the lead would
  then surface via stuck-in-stage / unreachable rather than be retried automatically.
