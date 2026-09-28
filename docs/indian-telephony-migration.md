# Indian telephony migration — scope

> **Status:** planned, not started. Provider not yet chosen — **Plivo currently leads**, see
> *Provider shortlist*. Blocked on provider KYC (commercial, not technical).
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

## Outbound: one step or two, depending on the provider

This differs per candidate and is the main driver of adapter cost. **Plivo keeps Twilio's
two-step shape** — its XML is TwiML-like, so `dialLeadTwiML` transliterates rather than
disappears, and the whisper-on-answer survives. Exotel collapses both legs into one API call:

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

**Net effect, Exotel:** the `voice/[leadId]` and `whisper` routes stop being needed for
outbound, and `dialLeadTwiML` / `xmlEscape` go with them.

**Net effect, Plivo:** they all stay, with their bodies rewritten to Plivo XML — more files
touched, but each change is mechanical and the call-control *shape* is already proven in
production. This is the cheaper and lower-risk of the two.

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

**This risk is Exotel-shaped and largely evaporates on Plivo.** Exotel's flows are built in
its App Bazaar and are less programmable — the ladder survives only if Exotel can fetch each
next destination from our endpoint mid-call. Plivo, returning XML per leg exactly as Twilio
does, keeps the ladder working the way it does today.

**Confirm before signing, whoever it is.** If a provider cannot do it, the options are a
shorter ladder (owner → round-robin → voicemail) or leaving inbound where it is while outbound
moves — they are independent numbers and can live on different providers.

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

Add `CALL_PROVIDER=twilio|plivo|exotel`, defaulting to `twilio`. Both adapters ship behind it.

1. `Call.provider` column + backfill (safe, independent, do first)
2. The chosen provider's adapter for **outbound only**, behind the flag
3. One real call on a handset before anyone else is switched
4. Flip outbound; Twilio stays configured and one variable away for a week
5. Inbound after outbound has settled — never the same day

Preflight (`scripts/preflight.ts`) gains a section for the chosen provider. The lesson from 21 September
applies directly: **it must verify against the provider that the Exophone can originate**,
not merely that a variable is set. "Configured" and "works" are different claims.

## Provider shortlist (evaluated 2026-09-29)

This doc was first written around Exotel because its API maps cleanly onto what we built.
**Exotel is no longer the front-runner.** Everything here — the provider seam, `Call.provider`,
the flag-based cutover, the questions — is provider-agnostic; only the adapter differs.

| Candidate | Verdict | Why |
|---|---|---|
| **Plivo** | **Leading** | India-registered businesses **can** rent Indian numbers and use domestic routes — we qualify. XML is TwiML-shaped (`<Dial callerId action>` with nested `<Number>`), so the adapter is the cheapest of any option. Has a **delete-recording API** (DPDP). Caller ID must be a *Plivo-rented* Indian number — our own Airtel line cannot be used |
| **Exotel** | Strong second | Purpose-built Indian CPaaS, best-documented two-leg connect API. Sales-led onboarding |
| **Airtel IQ** | Worth asking | Incumbent relationship may shorten KYC; may allow our own number as CLI. Least certain API maturity |
| **Netcore** | Unlikely | Voice product is campaign/OBD/IVR-shaped — upload prompts, schedule campaigns — not a programmable two-leg click-to-call. Primarily a martech/email company |
| **InterVoIP** | **No** | A softphone app from ICUK Computing Services (UK). No API, no Indian numbers, not a telecom provider. Not applicable |

**Why Plivo changes the estimate.** Plivo's XML was deliberately built Twilio-shaped. Our
`dialLeadTwiML` becomes a near-transliteration rather than a rewrite, the whisper-on-answer
pattern survives, and the inbound ladder — the single biggest risk with Exotel, because it
needs fresh call control returned per leg — keeps working the way it does today. That risk
largely evaporates.

## The number-series trap — ask this FIRST, of every provider

This is bigger than the choice of vendor and it applies to **all** of them, because it is TRAI
regulation, not a provider policy:

| Series | Permitted use |
|---|---|
| **Landline** (`022…`, `080…`) | Service and transactional calls **only** — promotional strictly prohibited |
| **140-series** | Promotional calls **only** |
| **160-series** | Service/transactional, **BFSI only** — not us |

**Why this could defeat the entire exercise.** A 140-series number is instantly recognisable in
India as telemarketing and is ignored or auto-blocked — which is the exact problem we are
trying to solve. Getting an Indian number is only a win if it is a *landline* series number.

And our calling is not all one kind. A counsellor ringing someone who just submitted an enquiry
is plausibly a **service** call. The **win-back campaigns** (`lib/campaigns/winback.ts`) ringing
leads who went cold months ago are far closer to **promotional**. On a landline number that is
prohibited; on a 140 number nobody answers.

**Consequences to settle before signing anything:**
1. Get the provider's written classification of our two call types.
2. Expect possibly **two numbers** — a landline for enquiry follow-up, a 140 for campaigns —
   and decide whether win-back calling survives that at all.
3. TRAI also requires **explicit digital consent** for commercial calls; cold calling is
   prohibited. Our leads arrive from web and Meta forms, so consent plausibly exists — but it
   must be *recorded and provable*, which is a CRM question, not a telephony one.

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

## Questions to put to EVERY provider before committing

Ask all of them the same list, in writing, while there is still leverage. Question 0 is the
one added on 29 September and it outranks the rest — see *The number-series trap*.

0. **Which number series** can we have, given we make both enquiry follow-up calls and
   win-back campaign calls? Will we need a landline number *and* a 140 number? Get the
   classification of our call types in writing.

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
