# Flow 2 — AI calling & retries

How the AI voice agent calls leads, retries the unanswered, respects the
do-not-call window, and honours callback requests.

## Trigger

A callable lead from intake (flow 1), or a delayed retry/callback job firing in the
worker.

## Step-by-step

1. **Place the call.** The app triggers **n8n Agent 1** (`lib/n8n.ts` →
   `N8N_WEBHOOK_NEW_LEAD`), which calls **ElevenLabs** to dial the lead via Twilio.
   `dynamic_variables` (lead id, call type, name, interest, prior context) round-trip
   so the post-call webhook can be correlated back.
2. **The attempt ladder (§3.1.2).** Attempt 1 is placed immediately at intake. On each
   **unanswered** result, `recordCall` (flow 3) schedules the next attempt via BullMQ:
   `RETRY_DELAYS_DAYS` (default `1,5`) → attempt 2 after 1 day, attempt 3 after 5 days.
   After the last delay with no answer, the lead is marked `unreachable`. Jobs are
   idempotent per `(lead, attempt)`.
3. **Do-not-call window (`lib/callWindow.ts`).** No automated call is placed between
   22:00 and 10:00 IST. A lead/retry landing in the window is pushed to the next
   opening (10:00 IST) and released FIFO by the worker, capped at
   `AI_MAX_CONCURRENT_CALLS`. Daytime leads call immediately without needing the worker.
4. **Callbacks (§3.1.2).** If a lead asks for a callback:
   - **with a specific time** → the retry ladder is cancelled and a single call is
     scheduled at that time (DND-adjusted);
   - **vague ("call me back") with no time** → scheduled for the next evening hour
     (`CALLBACK_HOUR`, default 19:00 IST).
5. **Opt-out suppression (§3.1.10).** A lead who says "not interested", or who sends
   WhatsApp `STOP`, is flagged `optedOut`; the worker hard-gates every future call,
   retry, and callback against this flag.

## Key files

- `lib/n8n.ts` — triggers Agent 1
- `lib/queue.ts` — `scheduleCallAttempt`, `cancelScheduledCalls`, retry math, DND defer
- `lib/callWindow.ts` — IST DND window + callback-hour math
- `workers/callQueueWorker.ts` — consumes attempt jobs, opt-out + DND gates
- `lib/providers/elevenlabsHealth.ts` — credit/health monitor (separate from flow 7)

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `RETRY_DELAYS_DAYS` | `1,5` | Days before each retry; count = number of retries |
| `DND_START_HOUR` / `DND_END_HOUR` | `22` / `10` | DND window (calls allowed 10:00–22:00 IST) |
| `CALLBACK_HOUR` | `19` | Default evening callback hour (IST) |
| `AI_MAX_CONCURRENT_CALLS` | `10` | Max simultaneous calls draining the queue |
| `N8N_WEBHOOK_NEW_LEAD` | — | Agent 1 webhook URL |

## Limitations

- **Live AI calling is currently gated on ElevenLabs credits.** With the account at
  zero, ElevenLabs cannot place calls; the trigger still fires but no conversation
  happens. (The ElevenLabs health monitor alerts Slack on this.)
- **Statutory TRAI DND is not implemented.** Only the internal _time window_ is
  enforced. Real DND scrubbing needs a DLT-registered provider/SMS-gateway DND API,
  which isn't wired; the gate is designed (consent overrides DND; WhatsApp exempt) but
  parked.
- **Retries depend on the worker being up.** Daytime first-attempts call immediately,
  but held/retry/callback calls require the worker service running to drain.
- **The attempt count is derived from the number of `Call` rows** for the lead, so a
  manually-logged call would shift the ladder.
- **No per-lead time-zone awareness.** All leads are treated as IST; an out-of-state
  patient in another zone is still called on the IST schedule.
