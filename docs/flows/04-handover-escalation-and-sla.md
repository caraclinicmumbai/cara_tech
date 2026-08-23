# Flow 4 — Handover, escalation & SLA

When the AI should stop and a human should take over: who gets the lead, how they
call it back (recorded), and what happens if they don't act in time.

## Trigger

Inside `recordCall` (flow 3), `evaluateHandover` (`lib/handover.ts`) checks the call
against 11 triggers. Any hit fires the handover.

### The 11 triggers

`price_request`, `clinical_question`, `emotional_distress`, `wants_human`,
`competitor_mention`, `unresolved_objection`, `high_cqs` (CQS ≥ threshold),
`unsupported_language` (outside `HANDOVER_SUPPORTED_LANGUAGES`), `hearing_impaired`,
`abusive`, `wrong_person_landline`.

Triggers come from two places: the ElevenLabs agent flags conversational ones
(passed as reason keys / booleans); the server owns the **CQS** and **language**
thresholds.

## Step-by-step

1. **Route to sales.** The AI drip stops (`cancelScheduledCalls`), `status` →
   `manual_followup` (or stays `confirmed`), and `needsHandover` / `handoverReason` /
   `handoverAt` / `handoverTriggers[]` are set.
2. **No re-assignment — it goes to the owner.** The lead was assigned a counsellor
   round-robin **at intake** (flow 1), so the handover simply routes to that person.
   Only a legacy lead with no owner gets one picked here (`pickOwnerRep`).
3. **Notify the rep — in the software first.** `notifyHandover` raises an **in-app
   notification** on the owner's login (`lib/notifications.ts`), shown on the **bell in
   the dashboard header** with an unread count; clicking it opens the lead and marks it
   read. It's a durable row, not a toast, so a telecaller who was away still sees the
   handover when they next sign in. Deduped per lead + trigger set, so a re-scored call
   doesn't stack bells.
   - The bell needs the counsellor to have a **CRM login linked to their `SalesRep`**
     (`User.salesRepId`). A rep with no login can only be reached on Slack.
   - Slack is an **additional** channel, not a replacement: the same alert is DM'd to
     the rep's `slackUserId` with the reason(s), transcript and a tap-to-call link
     (default channel if no rep / no Slack id). Leave `SLACK_BOT_TOKEN` unset for
     in-app-only notification.
   - **Owner away → a colleague covers, ownership doesn't move.** If the owner is
     `in_consultation` / `break` / `offline` (§presence), `pickReplacementFor` finds an
     available colleague — same speciality first — who gets the ping plus a **temporary
     access grant** (`grantCoverAccess`, `COVER_GRANT_DAYS` = 2, audited as a system
     grant, idempotent across repeat handovers). The alert names both: who's covering
     and who still owns it. The grant lapses on its own; the lead never leaves the
     counsellor it was assigned at intake.
4. **Distinct hot-lead alert.** If `high_cqs` fired, the alert is rendered as a
   **🔥 hot lead — close now** message (leads with the score) instead of the generic
   🤝 handover, so a ready-to-buy lead is visually distinct from a problem-handover.
5. **Counsellor oversight copy** is sent in parallel (flow 5).
6. **Recorded click-to-call (Twilio).** From the lead page, the rep hits "📞 Call &
   record": Twilio rings the rep's phone, then dials the lead, bridges, and records
   dual-channel. The recording webhook stores it as a `Call` (`human_handover`) and an
   in-app player streams it (session-gated proxy). The recording is then transcribed +
   scored (flow 3).
   - **Both numbers are normalised and sanity-checked first** (`lib/phone.ts`). Numbers
     are stored as typed — `9536108238`, `+91 7506452973` — and Twilio needs strict
     E.164, so a bare 10-digit mobile is read as `+91`. A number that can't be dialled
     (or an Indian mobile mis-prefixed `+1`, which is E.164-shaped but unroutable)
     **refuses the call with the reason on screen** instead of starting one that dies.
   - **A call that never connects is recorded too.** The `<Dial action>` callback
     (`/api/twilio/dial-result`) fires whatever the outcome — busy, no answer, carrier
     rejection — files a `Call` with the outcome, rings the rep's bell, reverts their
     In-Consultation status, and *tells them out loud* why the call is ending. Before
     this, the recording callback was the only one that fired, so a failed call left
     the rep in silence and the CRM with no record of it.
7. **Hot-call escalation (human path).** If a recorded human call itself scores ≥
   threshold, `escalateHotCall` raises the escalation flag and pings the owning rep.

## Staff-to-staff handover (the lead page's ownership panel)

Separate from the AI path above: a counsellor (or manager) transferring a lead to a
colleague by hand — `handoverLead` in `lib/leadOwnership.ts`, via the **Ownership &
access** panel on the lead page.

- **Who may.** The current owner or a manager/admin. Cross-branch (both branches known
  and different) additionally requires a manager **and** a written reason.
- **The receiver is told in-app**, same as an AI handover: a bell naming who handed it
  over and why, plus the Slack DM when configured. A **temporary access grant** raises
  its own bell for the grantee.
- **The giver doesn't get a 404.** Handing your own lead away usually costs you access
  to it, so the page you're standing on would answer not-found the instant the transfer
  lands. Instead the lead page shows **"{lead} is now with {rep}"** with the date, the
  reason, and a way back to the list. It's shown to exactly two people — the previous
  owner (matched on `meta.fromRepId` in the handover audit entry) and whoever performed
  the transfer (`actorId`) — so the record's existence still isn't leaked to anyone
  else, who continue to get the plain 404.

## Handover SLA (`lib/handoverSla.ts`)

When a "call this lead" handover alert is sent, a **2-hour timer** is scheduled
(BullMQ delayed job, idempotent per handover cycle). When it fires, the worker checks
whether the lead was **attended** — the handover was resolved, or a call was logged
after the handover. If still unattended, it **escalates to the counsellor** on Slack.
Skips if superseded by a newer handover or the lead is gone.

## Key files

- `lib/handover.ts` — triggers, `evaluateHandover`, `notifyHandover`, `escalateHotCall`
- `lib/salesReps.ts` — round-robin rota (`pickOwnerRep`, `pickReplacementFor`)
- `lib/leadOwnership.ts` — `grantCoverAccess` (cover an away owner without moving ownership)
- `lib/notifications.ts` — in-app notifications (`notifyRep`, feed, mark-read)
- `components/NotificationBell.tsx` + `app/api/notifications` — the header bell and its feed
- `lib/providers/twilio.ts` — recorded click-to-call + end-of-dial TwiML
- `lib/phone.ts` — `dialablePhone` / `toDialable` (E.164 normalisation + sanity check)
- `app/api/twilio/dial-result` — how a click-to-call ended (logs the failures)
- `lib/handoverSla.ts` — 2h unattended-handover escalation (worker queue)
- `app/api/twilio/*`, `app/api/webhooks/twilio/recording` — TwiML + recording webhook

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `HANDOVER_CQS_THRESHOLD` | `75` | CQS at/above this fast-tracks (high_cqs) |
| `HANDOVER_SUPPORTED_LANGUAGES` | `en,hi,mr` | Languages the AI handles; others → handover |
| `HANDOVER_SLA_HOURS` | `2` | Hours before an unattended handover escalates |
| `HANDOVER_ESCALATION_CHANNEL` | → counsellor channel | Where the SLA escalation goes |
| `TWILIO_*` | — | Account SID, auth token, caller id, public base |

## Limitations

- **Triggers depend on the ElevenLabs agent emitting reason keys.** Until the agent is
  configured to emit `handover_reasons` / `cqs` / `language` data points, only the
  server-owned CQS/language triggers fire for AI calls.
- **A rep dialling from their personal phone** (via the `tel:` link, not the in-app
  Call & record button) leaves no `Call` record, so the SLA reads it as **unattended**
  and may falsely escalate. Low-harm; nudge reps to use the in-app button.
- **Interactive Slack "Call & record" button** — the handover DM has a button that
  rings the rep who clicks and dials+records the lead (`/api/slack/interact`, verified
  via `SLACK_SIGNING_SECRET`). Requires Interactivity enabled in the Slack app with the
  Request URL set to `<base>/api/slack/interact`. The lead page has the same button.
- **Rep roster must be seeded** (`SalesRep` rows with phone + Slack id) for individual
  DMs and the call button; without it, alerts fall back to the channel and assignment
  is a no-op.
- **SLA escalation requires the worker** running to process the delayed job.
