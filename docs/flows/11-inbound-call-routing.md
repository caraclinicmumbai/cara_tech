# 11 — Inbound call routing (§presence)

What happens when a patient rings the number published on the website. This is the
only flow where the patient starts the conversation by phone — everywhere else the
clinic dials out ([flow 2](02-ai-calling-and-retries.md)) or messages
([flow 6](06-whatsapp-messaging.md)).

## The rule

**A patient who calls back reaches the person they already spoke to.**

Continuity is the whole point: nobody wants to re-explain their hair loss to a third
counsellor. So the routing is *sticky first, fair second* — the round-robin only gets
involved when the person's own counsellor genuinely can't take the call.

```
patient dials the clinic number
        │
        ├─ 1. their OWNER, if free ............................ sticky, the normal case
        ├─ 2. a colleague with the SAME speciality, if free ... cover
        ├─ 3. anyone free (round-robin) ...................... cover
        ├─ 4. ~25s hold, then one more pass over the whole team
        └─ 5. voicemail → "Return missed call" on the owner's roadmap + Slack
```

**A first-time caller** (no owner yet) skips rungs 1–3: the **telecallers** ring one by
one, round-robin, and **whoever answers becomes the lead's owner** — every later call from
that number is sticky to them. If nobody answers, the next telecaller in the rota gets the
lead and the "Return missed call" step.

```
first-time caller
        │
        ├─ telecallers, round-robin (role "Telecaller / Counsellor", Available) — no owner yet
        │      └─ the one who answers OWNS the lead from now on
        ├─ ~25s hold, then one more pass over the telecallers
        └─ voicemail / hang-up → next telecaller in the rota owns it + "Return missed call"
```

Each rung is tried for `INBOUND_RING_SECONDS` (default 20s) before moving on. A rep
who simply doesn't pick up is carried in `tried` and not rung again on that call.

## Trigger

The clinic number's voice webhook. Two carriers run the same ladder:

- **Plivo** (the Indian 022 landline): create a Plivo **Application** with
  Answer URL `POST <TWILIO_PUBLIC_BASE>/api/plivo/inbound` and
  Hangup URL `POST <TWILIO_PUBLIC_BASE>/api/plivo/inbound/hangup`, and attach the number to it.
- **Twilio**: set the number's **"A CALL COMES IN"** to `POST <TWILIO_PUBLIC_BASE>/api/twilio/inbound`.

## In the call log: IVR Incoming / IVR Missed

Every inbound call is one `Call` row of type `inbound`, shown with its own label
(`callTypeLabel()` in `lib/inboundCallLog.ts`):

| Label | When |
|---|---|
| **IVR Incoming** | A counsellor picked up (outcome `connected`), or the call is still ringing through the ladder (`ringing`). *Handled by* names the counsellor who answered |
| **IVR Missed** | Nobody picked up — the caller hung up while it rang (`missed`), or left a message (`voicemail`). Twilio's older `inbound_voicemail` rows show as IVR Missed too |

On Plivo the row is created on the **first** webhook, before anyone's phone rings, keyed on
the `CallUUID`, and every later callback updates it — so an unanswered call is in the log
even when no voicemail was left. A missed call also puts a **"Return missed call"** step
(due now) on the owner's roadmap, rings the owner's bell (`missed_call`), and posts
`missed_inbound` to the counsellor channel — once per call, however many callbacks arrive.

## Step by step

### 1. Identify the caller

`routeInboundCall()` matches the caller's number against leads on the **last 10
digits** — the same rule the duplicate detector uses, so `+919876543210` and
`9876543210` are one person. Where several records share a number it takes the
**earliest**, which is the canonical person rather than whichever copy is newest.

An unknown number becomes a lead there and then, named `Caller 1234` from the last
four digits, with source **`inbound_call`** — and **no owner** (`deferOwner`). The lead is
claimed by the telecaller who answers (`claimUnownedLead()` in `lib/salesReps.ts`, called
from the whisper routes, the earliest "they picked up" signal; on Plivo the completed dial
claims it too, in case the whisper was lost). The claim is a conditional update, so it
never overwrites an owner, and it hands the lead's unowned follow-up steps to the same
person. A lead that already has an owner from any other source (web form, ad) is sticky
to that owner as before. That source is in `NEVER_AUTO_CALL`
alongside `walk_in`: firing an automated AI cold-call at someone who just rang the
clinic would be the worst possible first impression, so they go to the manual queue.

### 2. Choose who rings

| Rung | Condition | Where |
|---|---|---|
| Owner (sticky) | `Lead.assignedRepId` is reachable | `routeInboundCall()` |
| Same speciality | owner unreachable | `pickReplacementFor()` (`lib/salesReps.ts`) |
| Round-robin | no same-skill colleague free | `pickReplacementFor()` |
| Telecallers, round-robin | first-time caller (lead has no owner) | `pickNextTelecaller()` |

**Reachable** means: `active`, `availability === "available"`, **not** already `onCall`,
and carrying a dialable number. **During clinic hours** (outside the 22:00–10:00 IST call
window) Cara also rings people marked **Offline** once nobody Available is left — and the
lead's own owner even if they're Offline. Presence auto-sets anyone Offline after 15 minutes
without the CRM open, which says nothing about whether their phone is in their pocket; the
first live test rang nobody because of exactly that. **Break** and **In consultation** are
never rung — except an **In consultation older than 2 hours**, which is treated as a call
whose end never reached Cara (lost callback) and rung like Offline. If **no telecaller**
can take a first-time call, the rest of the sales rota (anyone with a login, not a sales
head) is tried the same way, so a roster without the Telecaller role still answers. The
counsellor's leg shows `PLIVO_REP_CALLER_ID` / `PLIVO_CALLER_ID`, or the clinic number
the patient dialled when neither is set. A sales head who personally owns a lead still gets
their own caller back — the round-robin excludes managers, but stickiness is about who
this patient knows.

Cover never takes ownership: when a colleague answers for an absent owner, the lead stays
with its owner. Only an unowned lead is assigned — to whoever answers, or on a miss to the
next telecaller in the rota (`raiseMissedCallFollowUp()`).

> **Phone numbers must be dialable.** `SalesRep.phone` is documented as E.164 but the
> roster is hand-typed. `dialablePhone()` upgrades a bare 10-digit Indian mobile to
> `+91…` and refuses anything else, logging a warning and falling through to the next
> counsellor — a mis-dialled patient call is worse than a slower answer.

### 3. Connect

**Plivo** does the same thing in Plivo XML: `confirmSound` on the `<Dial>` is the
counsellor-only whisper (`/api/plivo/inbound/whisper`, which also marks the row connected
and handled by them), a `<Record recordSession>` before the `<Dial>` records the
conversation onto the same row (`/api/webhooks/plivo/recording?…&inbound=1`), and the
`<Dial action>` drives the ladder. The counsellor's handset shows the clinic's Plivo number
(Indian routes require a rented caller ID), which is why the whisper names the caller.
The Plivo **hang-up** callback settles any row still ringing as IVR Missed.

**Twilio:** the TwiML greets the caller (including the recording disclosure, §compliance C1) and
`<Dial>`s the chosen counsellor. Two callbacks hang off it:

- **`<Number url=…>` → `/api/twilio/inbound/whisper`** — fetched only when the rep
  actually answers, which makes it the earliest reliable "picked up" signal. It
  announces *"Your patient Priya is calling"* to the counsellor alone, and flips them
  to **In-Consultation** so the next inbound call doesn't ring a handset already in use.
- **`action` → back to `/api/twilio/inbound`** — fires when the leg ends for any
  reason. `DialCallStatus=completed` means they spoke: hang up. Anything else advances
  the ladder with the rep added to `tried`.

The call is recorded (`record-from-answer-dual`) and posted to the existing recording
webhook with `inbound=1`, which files it as a `Call` of type **`inbound`** and
transcribes + CQS-scores it like any other.

### 4. Nobody free

The caller is held for `INBOUND_HOLD_SECONDS` (default 25s) and then the **whole
ladder runs again** — `tried` is deliberately dropped, so a counsellor who hung up
during the hold picks this call up rather than it dropping to voicemail the instant
everyone happened to be busy.

### 5. Voicemail

On Plivo, every unanswered call's hang-up also fetches the call's recording from Plivo's
API (`collectPlivoVoicemail`, retrying for about a minute) — the first live voicemail never
reached the CRM through the callbacks, though Plivo had recorded it. Recordings under a
second are a caller hanging up at the tone and stay a plain missed call.

`/api/plivo/inbound/voicemail` attaches the message to the call's row
(IVR Missed, outcome `voicemail`) and transcribes it once Plivo says the audio is ready
(`ready=1`). If the caller hangs up mid-message, the hang-up marks the call missed first and
the recording upgrades it to voicemail without a second alert.

On Twilio, `/api/twilio/inbound/voicemail` stores the message as a `Call` of type
**`inbound_voicemail`**, adds a **"Return missed call"** step to the owner's roadmap
(due immediately), and posts a `missed_inbound` alert to the counsellor channel. The
recording is transcribed, so nobody has to listen to it to triage it.

Twilio fires this URL twice for one message (the `<Record>` action *and* the recording
status callback), so it is idempotent on `CallSid`.

## Security

Every route verifies `X-Twilio-Signature` over the exact public URL Twilio called,
using the same helper as the outbound webhooks. Without it, anyone who guessed the
path could make the clinic dial arbitrary numbers.

> **Encoding trap.** Signature checks compare the URL Twilio signed against one rebuilt
> from `req.url`, and Next re-encodes some characters on the way in — a raw `,` arrives
> as `%2C`, which fails the comparison and silently 403s the whole ladder. The `tried`
> list is therefore repeated `tried=<id>` params of bare cuids, which need no encoding
> at all. Don't put punctuation in these query strings.

## Key files

| File | Role |
|------|------|
| [lib/inboundRouting.ts](../../lib/inboundRouting.ts) | The policy: who takes this call. Provider-agnostic — no TwiML, no webhooks |
| [lib/inboundCallLog.ts](../../lib/inboundCallLog.ts) | The call-log row (IVR Incoming / IVR Missed) and the missed-call follow-up |
| [app/api/plivo/inbound/route.ts](<../../app/api/plivo/inbound/route.ts>) | Plivo adapter: answer URL + the fall-through ladder |
| [app/api/plivo/inbound/whisper/route.ts](<../../app/api/plivo/inbound/whisper/route.ts>) | Plivo counsellor whisper; marks the call connected |
| [app/api/plivo/inbound/hangup/route.ts](<../../app/api/plivo/inbound/hangup/route.ts>) | Plivo hang-up: an unanswered call becomes IVR Missed |
| [app/api/plivo/inbound/voicemail/route.ts](<../../app/api/plivo/inbound/voicemail/route.ts>) | Plivo voicemail → the call's row + transcription |
| [app/api/twilio/inbound/route.ts](<../../app/api/twilio/inbound/route.ts>) | Twilio adapter: entry point + the fall-through ladder |
| [app/api/twilio/inbound/whisper/route.ts](<../../app/api/twilio/inbound/whisper/route.ts>) | Counsellor whisper + the In-Consultation flip |
| [app/api/twilio/inbound/voicemail/route.ts](<../../app/api/twilio/inbound/voicemail/route.ts>) | Message → Call + roadmap step + Slack |
| [lib/providers/twilio.ts](../../lib/providers/twilio.ts) | TwiML builders, signature verification |
| [lib/salesReps.ts](../../lib/salesReps.ts) | `pickReplacementFor()` / `pickNextRep()` — the cover ladder |
| [lib/presence.ts](../../lib/presence.ts) | Availability state machine ([flow 5](05-counsellor-and-manager-alerts.md)) |

Swapping carrier means writing a new adapter against `routeInboundCall()` — the policy
does not move.

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `TWILIO_INBOUND_NUMBER` | — | The published clinic number; caller ID on the rep's leg |
| `INBOUND_RING_SECONDS` | 20 | How long one counsellor's phone rings before moving on |
| `INBOUND_HOLD_SECONDS` | 25 | Hold before the final pass over the team |
| `CLINIC_CALL_GREETING` | built-in | Spoken greeting. **Keep the recording disclosure** if reworded |
| `TWILIO_PUBLIC_BASE` | `NEXTAUTH_URL` | Base URL Twilio calls back on — must be the exact public host |

## Limitations

- **Not wired to a live number yet.** The Plivo number needs an Application pointing at
  the two URLs above. Everything here is verified against signed simulated Plivo and Twilio
  requests, not a real call.
- **The website number (+91 77770 34066, Airtel) must be forwarded to the Plivo 022
  number**, and the forwarded call must still carry the patient's own number. If Airtel
  presents its own number instead, every caller looks like one person. Verify with a test
  call before relying on it.
- **First-time callers only ring users with the Telecaller / Counsellor role** who are on
  the roster with a login and marked Available. No such telecaller → straight to hold,
  then voicemail.
- **Offline people are rung in clinic hours.** Someone genuinely off shift but left as
  Offline (not Break) may get a call on their mobile. Set Break, or deactivate the rep,
  for leave.
- **The call log and dashboard refresh themselves every 15 / 30 s** and the bell every
  15 s — not instantly.
- **On Twilio, a caller who hangs up without leaving a voicemail leaves no row.** Only the
  Plivo adapter logs the call from its first ring.
- **A Twilio +91 number needs India regulatory approval** (KYC bundle, address proof)
  before it can receive calls, and Indian carriers restrict what caller ID may be
  presented. If the console rejects the caller ID, the rep's leg will need to show a
  Twilio-owned number instead of the clinic number.
- **Stickiness follows lead ownership, not conversations.** Reassigning a lead moves
  the caller to the new owner immediately — intended, but it means a handover changes
  who picks up before the patient has met them.
- **A patient with duplicate lead records resolves to the earliest.** If the active
  work is happening on a newer duplicate, the call still routes by the original's
  owner. Merging duplicates fixes it.
- **No IVR, no business-hours branch, no queue position.** Every caller gets the same
  ladder at any hour; out of hours, nobody is available and they reach voicemail after
  the hold.
- **The hold is a fixed pause, not a real queue.** The caller hears silence for the
  hold window (no music), and callers are not ordered — two people holding are
  independent.
- **`onCall` only tracks calls this system placed or received.** A counsellor talking
  on their mobile outside the CRM still looks reachable and will be rung.
