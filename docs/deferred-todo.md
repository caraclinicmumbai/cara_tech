# Deferred TODO — things to do later

> **Purpose.** A running list of work that was consciously *deferred* — mentioned during
> development but intentionally not done yet. **Claude: consult this file when wrapping up a
> phase, before a go-live, or whenever the user asks "what's left / what did we defer."** Add a
> new row (with date + context) whenever the user says "we'll do X later." Move items to
> **Done** (or delete) once completed; keep the reason so the history is legible.
>
> For the deeper engineering/compliance backlog (security, DPDP, tests, etc.) see
> [gaps-and-roadmap.md](./gaps-and-roadmap.md) — this file is for *user-deferred* items.

---

## Open

### 🔴 Go-live: actually turn ON follow-up campaigns
The campaign **code** is deployed to production, but the engine is **dormant** by design
(`CAMPAIGNS_ENABLED` defaults off) and messaging templates aren't set, so nothing enrolls or
sends yet. To go live:
1. **Create + approve the WhatsApp templates** in `/templates` (they need Meta approval), then
   set their env names on the Railway **web + worker** services:
   - Couldn't Reach: `WHATSAPP_TEMPLATE_CR_DAY1` / `_CR_DAY5` / `_CR_DAY14` / `_CR_DAY30`
   - Worried About Cost: `WHATSAPP_TEMPLATE_WC_DAY1` / `_WC_DAY3` / `_WC_DAY7` / `_WC_DAY14`
   - Just Researching: `WHATSAPP_TEMPLATE_JR_WK1` … `_JR_WK6`
   - Win-Back: `WHATSAPP_TEMPLATE_WINBACK` · Dead-Lead: `WHATSAPP_TEMPLATE_DEADLEAD`
2. **Set `CAMPAIGNS_ENABLED=true`** on Railway web + worker.
   - ⚠️ Enabling *before* templates exist means enrollments happen and schedules advance, but
     sends are safe no-ops — **except** Couldn't Reach still **marks leads Lost** after day 30,
     and the win-back sweep still enrolls Lost leads. So set templates first, then enable.
3. Optional tuning envs (all have defaults): `CAMPAIGN_TICK_MINUTES`, `WINBACK_AFTER_DAYS`,
   `WINBACK_CONSENT_MAX_AGE_DAYS`, `WINBACK_SWEEP_HOURS`.
_Added 2026-07-28._

### 🔴 Twilio Auth Token is invalid — refresh it (health monitor alerting)
The Slack downtime feed is firing "Twilio API down" — but Twilio is **up**; the API returns
`401 / error 20003 (Authenticate)`, i.e. the stored `TWILIO_AUTH_TOKEN` is being **rejected**
(almost certainly rotated in the Twilio Console). SID/token formats are valid, so it's the
value, not a typo. **Impact while broken:** click-to-call handovers, recording fetch/playback,
and the C3 erasure/retention recording-deletes all fail. **Fix:** copy the current Auth Token
from Twilio Console → Account → Keys & tokens, and set `TWILIO_AUTH_TOKEN` in `.env.local` +
Railway **web** and **worker**, then re-run the health probe to confirm 200. Optional polish:
make `checkTwilio` report "auth failed (401)" distinctly from a real outage
(`lib/healthMonitor.ts`). _Added 2026-08-08 (user deferred; "we'll do it later")._

### 🔴 Go-live: add the AI recording-consent disclosure to the ElevenLabs agent (C1)
The CRM side of recording consent is built and deployed (`Call.recordingConsent`; human-
handover calls disclose to the patient via a Twilio whisper). **Remaining, config-only, on
ElevenLabs (can't be set from code):** update the "Manish" agent prompt so its opening line
announces the call is recorded, and have it emit `recording_consent = true`. Until then AI
calls store no consent flag and CQS keeps docking the consent dimension. Script + field spec:
[elevenlabs-agent-integration.md](./elevenlabs-agent-integration.md) §7. _Added 2026-07-29._

### Data-retention window (C3) — decide + enable
The retention-purge job ships **off** (`DATA_RETENTION_MONTHS` unset = no-op). Before go-live,
decide a window (e.g. 12 months) with legal sign-off and set `DATA_RETENTION_MONTHS` on the
Railway **worker** (optional `RETENTION_SCAN_HOURS`, default 24). It then redacts recordings +
transcripts on calls older than the window (and deletes their Twilio audio). _Added 2026-07-29._

### International Patient campaign (email)
The 7th follow-up campaign (`international`) — WhatsApp **+ email** in English. Declared but
stepless because there's **no email provider wired up**. Needs: pick/integrate an email
provider, add email as a second channel to the campaign engine, then give `international` its
step schedule. _Deferred 2026-07-28 (user chose to do it later)._

---

## Done
_(nothing yet — move completed items here with the date + commit)_
