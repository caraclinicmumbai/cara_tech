# Exotel migration — scope

> **Status:** planned, not started. Blocked on provider KYC (commercial, not technical).
> **Why:** [deferred-todo.md](./deferred-todo.md) — Twilio cannot originate an Indian CLI
> for us, proven 2026-09-21 with error 13247 on six consecutive calls.

---

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

## Implementation note

Per [AGENTS.md](../AGENTS.md), read the relevant guide in `node_modules/next/dist/docs/`
before writing the route handlers — this Next version's conventions differ from the ones in
general circulation, and the webhook routes are the part most likely to be written from
memory.
