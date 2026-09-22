# Exotel migration — scope

> **Status:** planned, not started. Blocked on provider KYC (commercial, not technical).
> **Why:** [deferred-todo.md](./deferred-todo.md) — Twilio cannot originate an Indian CLI
> for us, proven 2026-09-21 with error 13247 on six consecutive calls.

---

## Twilio confirmed it in writing (2026-09-21)

We asked Twilio Support directly. Their answer, verbatim in substance:

| Number type | Outbound voice | Usable as CLI into India |
|---|---|---|
| Indian **local** | Not available | No — cannot be purchased or ported |
| Indian **mobile** | Not available | No — cannot be purchased or ported |
| Indian **toll-free** | By special request | Yes, with restrictions |
| **Verified** non-Twilio | Not supported | No — DNO + Indian regulation |

> *"If presenting a local Indian CLI is a strict requirement for your use case, you will need
> to consider alternative providers who can offer this capability under Indian regulations."*

**The toll-free exception does not apply to us, and this is the detail that closes the last
door.** Twilio's India toll-free product requires *"the business or individual to be **outside
of India**"* — it exists for foreign companies dialling into India. Cara is a Mumbai clinic.
We are the wrong side of that rule and cannot buy it.

Even if we could: a 1800 number presented on an outbound call to a patient reads as
telemarketing, not as their clinic, and the recipient must be able to receive toll-free calls
at all. It would be a worse caller ID than the one we have.

So there is no Twilio configuration, purchase, or escalation that solves this. The vendor has
said so itself. This question is closed — do not reopen it.

## The one-paragraph reason

Twilio owns one number on our account, `+18104280484` (US). An Indian number can be
*verified* on the account, which is enough to be the `From` on a REST call — that is why the
counsellor's leg always worked — but Twilio will not **originate** into India presenting a
CLI it never issued. Patients therefore see a foreign number, Truecaller flags it, and they
do not answer. No Twilio setting changes this; the fix is a provider that originates the
call **inside India** on an Exophone we control.

## What is actually being replaced

Less than it looks. The policy is already separated from the provider — `lib/inboundRouting.ts`
holds *who to ring* and says so explicitly ("this file is the Twilio adapter and holds no
policy of its own"). What is Twilio-shaped is the **call control**, not the business logic.

| Layer | Fate |
|---|---|
| `lib/inboundRouting.ts` — ladder policy | **Keep**, untouched |
| `Call` rows, CQS, transcription, lead attribution, presence flips | **Keep** |
| `lib/phone.ts` E.164 normalisation | **Keep** |
| `leads/actions.ts` → `callLeadAndRecord` guards | **Keep** — swap one call |
| `lib/providers/twilio.ts` TwiML builders | **Replace** — Exotel has no TwiML |
| `api/twilio/voice/[leadId]`, `api/twilio/whisper` | **Disappear** for outbound (see below) |
| `api/twilio/dial-result` | **Becomes** Exotel `StatusCallback` |
| `api/webhooks/twilio/recording` | **Rewrite** — different payload, different auth |
| `api/twilio/inbound/*` | **Rewrite** — the risk area, see *Inbound* |

## Outbound: two steps become one

Twilio needs a round trip through us. Exotel does not:

```
TWILIO   REST create call (ring rep)  →  rep answers  →  Twilio fetches OUR TwiML
         →  <Dial callerId=+91> patient  →  action callback  →  recording callback

EXOTEL   POST /v1/Accounts/<sid>/Calls/connect.json
           From=<counsellor>  To=<patient>  CallerId=<Exophone>
           Record=true  StatusCallback=<us>  CustomField=<leadId:repId>
         →  Exotel dials the counsellor, then the patient, bridges, records
         →  one StatusCallback with CallSid + RecordingUrl
```

Exotel's connect API is the same two-leg model we already built, which is why this is a
contained change rather than a redesign. `CustomField` carries `leadId` / `repId` through,
replacing the query-string threading on the callback URLs.

**Net effect:** the `voice/[leadId]` and `whisper` routes stop being needed for outbound, and
`dialLeadTwiML` / `xmlEscape` go with them.

## The migration-period trap: old recordings stay on Twilio

`Call.recordingUrl` rows written before cutover point at Twilio and need **Twilio** auth to
fetch ([callTranscription.ts:26](../lib/callTranscription.ts#L26)) or delete
([dataRetention.ts:60](../lib/dataRetention.ts#L60) — DPDP erasure, §compliance C3). After
cutover, new rows point at Exotel. A single `fetchRecording()` cannot guess which.

**Therefore: add `Call.provider` (`String @default("twilio")`) before the cutover, not after.**
Backfill is free — every existing row is Twilio by definition — and `fetchRecording` /
`deleteRecording` dispatch on it. Skipping this silently breaks erasure for historical calls,
which is the kind of thing that stays broken until somebody exercises a DPDP request.

## Inbound: the part that carries real risk

Our ladder is driven by returning fresh TwiML per leg — sticky owner → same-speciality
colleague → round-robin → hold → second pass → voicemail, with `tried` carried forward so no
handset rings twice. That works because Twilio asks us what to do after *every* leg.

Exotel's flows are built in its App Bazaar and are **less programmable**. The ladder survives
only if Exotel can fetch each next destination from our endpoint mid-call.

**This must be confirmed before signing.** If it cannot, the options are a shorter ladder
(owner → round-robin → voicemail) or keeping inbound on a Twilio number while outbound moves —
they are independent numbers and can live on different providers.

## Compliance: two things that do not port automatically

1. **Recording disclosure to the patient (§compliance C1).** Today a `<Number url>` whisper
   plays to the patient before the legs bridge. Exotel's equivalent is a greeting applet in
   the flow — needs building and verifying, not assuming. A recorded call with no disclosure
   is a worse problem than a foreign caller ID.
2. **Recording deletion (§compliance C3).** Twilio has a delete endpoint. Whether Exotel
   exposes one over API — rather than via a support ticket — is an open question and a
   **hard requirement** for DPDP erasure.

## Webhook authentication changes shape

`verifyTwilioSignature` is HMAC-SHA1 over URL + sorted params. Exotel does not sign that way —
it uses HTTP Basic auth on the callback URL and/or IP allowlisting. The security property we
need is unchanged (nobody may POST a fake recording or leak a patient number from
`voice/[leadId]`), but the mechanism is different and must be built deliberately, not left
open because the old check no longer applies.

## Cutover

Add `CALL_PROVIDER=twilio|exotel`, defaulting to `twilio`. Both adapters ship behind it.

1. `Call.provider` column + backfill (safe, independent, do first)
2. Exotel adapter for **outbound only**, behind the flag
3. One real call on a handset before anyone else is switched
4. Flip outbound; Twilio stays configured and one variable away for a week
5. Inbound after outbound has settled — never the same day

Preflight (`scripts/preflight.ts`) gains an Exotel section. The lesson from 21 September
applies directly: **it must verify against the provider that the Exophone can originate**,
not merely that a variable is set. "Configured" and "works" are different claims.

## The provider is not finally chosen — run two in parallel

This doc is written around Exotel because its click-to-call API maps most cleanly onto what we
already built. **Exotel is the reference, not the decision.** Everything here — the provider
seam, `Call.provider`, the flag-based cutover, the eight questions — is provider-agnostic.

**Airtel IQ is a serious candidate, and possibly a faster one.** Distinguish two Airtel
products that get called the same thing in conversation:

| | What it is | Use to us |
|---|---|---|
| **Airtel IVR** / toll-free | A managed inbound IVR — menu trees, routing to desks | **No.** Inbound-shaped, not a programmable outbound API |
| **Airtel IQ** | Airtel's CPaaS platform — voice/SMS/WhatsApp APIs | **Possibly yes** — this is the one to ask about |

The argument for Airtel IQ is not technical, it is **time**. KYC is the entire critical path,
and the clinic is already an Airtel customer with documents on file and a signed relationship.
An existing-customer onboarding can be materially faster than a cold one, and it may make
question 7 (our own line as outbound CLI) a much easier yes — it is their number.

The argument against is maturity: Exotel's voice API is better documented and more widely used
for exactly this two-leg click-to-call pattern. Airtel IQ must be held to the **same eight
questions**, with no benefit of the doubt for being the incumbent. Recording deletion over API
and mid-call dynamic routing are the two most likely to come back "no".

**So approach both, the same week, with the same questions.** They are free to ask and the
answers are comparable. Whoever answers well *and* moves fast wins — and if Airtel IQ can
originate on the clinic's existing number, it wins on reputation too, because patients would
see a number the clinic already publishes.

## Onboarding runbook (the commercial path)

> Exotel's exact process may have changed — confirm each step with them rather than
> treating this as gospel. The *sequence* and the decision points are the durable part.

### Phase 0 — Gather before you contact anyone (1 evening)

Nothing here needs Exotel, and having it ready is the difference between a two-week
onboarding and a five-week one. Indian telecom KYC is DoT-mandated and they cannot waive it.

- Certificate of Incorporation **or** GST certificate **or** Shop & Establishment licence
- Company **PAN**
- Registered **address proof** (utility bill / rent agreement / bank statement)
- **Authorised signatory ID** (Aadhaar + PAN) and, for a company, a board resolution or
  authorisation letter naming them
- **Expected monthly outbound minutes** — the first thing sales asks; a rough number is fine
- The existing **business landline number** and which operator issued it (for questions 7–8)

### Phase 1 — First contact

Exotel is sales-led for business accounts; a self-serve signup usually lands you in a trial
with limited capability. Contact sales at exotel.com and put the eight questions below in
that first conversation, in writing, so the answers are on record.

**Ask one more thing that is not on that list:** *can we have API credentials on a trial or
sandbox account while KYC is processing?* If yes, the integration is built in parallel with
the paperwork instead of after it — that is potentially two or three weeks off the date, and
it costs nothing to ask.

### Phase 2 — KYC submission

Submit the Phase 0 documents plus a signed **CAF** (Customer Application Form). Expect days
to weeks. A missing or mismatched document restarts the clock, so check that the entity name
matches **exactly** across the CoI, PAN and address proof before submitting.

### Phase 3 — Choose the Exophone (a real decision, not a formality)

Exotel issues the number. Two formats, and they behave differently:

| | Reads as | Best for |
|---|---|---|
| **Landline** (e.g. `022…`) | An established Mumbai clinic | The **published** number patients call |
| **Mobile** (`+91 9x…`) | A person calling you | **Outbound** to patients — generally answered more |

For our use case these are different jobs, and it is worth asking for **both**: a mobile-format
Exophone as the outbound CLI on click-to-call, and a landline as the published inbound number.
If budget allows only one, take the mobile format — outbound answer rate is the problem we are
solving.

**Unless question 7 comes back yes**, in which case the clinic's existing business line becomes
the outbound CLI and carries whatever recognition it already has.

### Phase 4 — Credentials and a sandbox call

You will receive an **API key**, **API token**, **Account SID** and a **subdomain**. These are
production credentials for a paid telecom service — they go straight into Railway variables,
never into the repo, and never into a chat window.

Before any integration work is trusted: place **one manual call from Exotel's dashboard** to a
handset you are holding, and look at the screen. That is the test that was never run before
the Twilio attempt, and running it early is the whole lesson of September.

### Phase 5 — Integration

See the scope above. `Call.provider` lands first (independent of Exotel), then the outbound
adapter behind `CALL_PROVIDER`, then one real call, then the flip. Inbound moves on a
different day.

### Phase 6 — Truecaller

Register whichever number **ends up dialling**, once it is settled and not before.

## Questions to put to Exotel before committing

Ask these during onboarding, while there is still leverage:

1. Can a call flow fetch its **next destination dynamically** from our HTTPS endpoint mid-call?
   (Decides whether the inbound ladder survives.)
2. Is there an **API to delete a recording**, or is it a support request? (DPDP erasure.)
3. Can an **announcement play to the callee only**, before the legs bridge? (Recording consent.)
4. How are **webhooks authenticated** — Basic auth, signature, IP allowlist?
5. What is the **DND / TRAI scrubbing** behaviour on outbound calls to patients who are
   registered? (Open item in [gaps-and-roadmap.md](./gaps-and-roadmap.md).)
6. Does the Exophone support **inbound**, so callbacks land in the CRM instead of a
   counsellor's handset?
7. **Can our existing business line be used as the outbound CLI?** The clinic already holds
   a telecom-operator business number. It has no API — nothing can dial through it — but
   Indian providers can often provision a customer-owned number as the outbound caller ID
   given an authorisation letter / NOC from the operator. If yes, patients see a number the
   clinic already publishes instead of a fresh one with no reputation, and any Truecaller
   standing it has carries over.
8. **Can it be ported, or forwarded in?** Failing 7 — can that number be ported onto the
   platform, or forwarded to the Exophone so calls patients already make to it land in the
   CRM rather than ringing a desk nobody is sitting at?

> **Note on Truecaller.** Register whichever number ENDS UP DIALLING. Paying to list
> `+18104280484` makes sense only if the provider move is more than a month out — if the
> answer to 7 is yes, the listing belongs on the business line instead, and registering the
> US number first is money spent on a number about to be retired.

## Implementation note

Per [AGENTS.md](../AGENTS.md), read the relevant guide in `node_modules/next/dist/docs/`
before writing the route handlers — this Next version's conventions differ from the ones in
general circulation, and the webhook routes are the part most likely to be written from
memory.
