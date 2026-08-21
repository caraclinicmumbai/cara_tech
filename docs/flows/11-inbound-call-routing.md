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

Each rung is tried for `INBOUND_RING_SECONDS` (default 20s) before moving on. A rep
who simply doesn't pick up is carried in `tried` and not rung again on that call.

## Trigger

Twilio's Voice webhook on the clinic number. In the Twilio console, set that number's
**"A CALL COMES IN"** to `POST <TWILIO_PUBLIC_BASE>/api/twilio/inbound`.

## Step by step

### 1. Identify the caller

`routeInboundCall()` matches the caller's number against leads on the **last 10
digits** — the same rule the duplicate detector uses, so `+919876543210` and
`9876543210` are one person. Where several records share a number it takes the
**earliest**, which is the canonical person rather than whichever copy is newest.

An unknown number becomes a lead there and then, named `Caller 1234` from the last
four digits, with source **`inbound_call`**. That source is in `NEVER_AUTO_CALL`
alongside `walk_in`: firing an automated AI cold-call at someone who just rang the
clinic would be the worst possible first impression, so they go to the manual queue.

### 2. Choose who rings

| Rung | Condition | Where |
|---|---|---|
| Owner (sticky) | `Lead.assignedRepId` is reachable | `routeInboundCall()` |
| Same speciality | owner unreachable | `pickReplacementFor()` (`lib/salesReps.ts`) |
| Round-robin | no same-skill colleague free | `pickReplacementFor()` / `pickNextRep()` |

**Reachable** means: `active`, `availability === "available"`, **not** already `onCall`,
and carrying a dialable number. A sales head who personally owns a lead still gets
their own caller back — the round-robin excludes managers, but stickiness is about who
this patient knows.

A caller with no owner is **assigned** to whoever takes the call, so the next one is
sticky. An unknown caller is assigned once, by intake, and not reassigned.

> **Phone numbers must be dialable.** `SalesRep.phone` is documented as E.164 but the
> roster is hand-typed. `dialablePhone()` upgrades a bare 10-digit Indian mobile to
> `+91…` and refuses anything else, logging a warning and falling through to the next
> counsellor — a mis-dialled patient call is worse than a slower answer.

### 3. Connect

The TwiML greets the caller (including the recording disclosure, §compliance C1) and
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

`/api/twilio/inbound/voicemail` stores the message as a `Call` of type
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

- **Not wired to a live number yet.** Production carries no Twilio configuration at
  all, and the number on the website is not yet pointed at this webhook. Everything
  here is verified against signed simulated Twilio requests, not a real call.
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
