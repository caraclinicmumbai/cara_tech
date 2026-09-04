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

### 🟠 Indian caller ID — configured, needs a production switch and a live test
From the 2026-09-03 test run: **two calls placed from the CRM went unanswered; the same
patients answered a Neodove call minutes later.** The cause was `TWILIO_CALLER_ID` being a
**US `+1` number** — an Indian patient sees an unknown international caller, and Truecaller
flags it as spam.

**Resolved locally, 2026-09-04.** No purchase was needed: the Twilio account already had
**two verified Indian outgoing caller IDs**. `TWILIO_CALLER_ID` is now
**`+917710070566`** (verified 23 Apr 2025; matches no lead and no rep, and shares the
`77100` series with the WhatsApp number, so it reads as the clinic's line). `preflight.ts`
confirms it.

**Two things remain:**

1. **Set `TWILIO_CALLER_ID=+917710070566` on Railway** (web *and* worker). Until then
   production still dials as `+1 810 428 0484` — the local change fixes nothing for
   patients.
2. **Place one real test call and look at the handset**, because this may not survive
   contact with Indian carriers. India's DoT has directed operators to **block incoming
   international calls that display an Indian CLI**, precisely because that is the
   signature of spoofed scam calls. A Twilio call originating outside India showing `+91`
   fits that description. Three outcomes are possible and only a test distinguishes them:
   - the `+91` number shows → problem solved, for free;
   - the CLI is replaced or shows as unknown/international → no better than before;
   - the call is blocked outright → worse than before, revert immediately.

**If the test fails, the durable answer is an Indian provider** — Exotel, Knowlarity,
Ozonetel, MyOperator or Acefone. They originate the call *inside* India, so the CLI is
legitimate rather than borrowed; this is what Neodove itself runs on, and it also settles
the TRAI DND gap in `gaps-and-roadmap.md`. Cost: a monthly plan plus per-minute. Work: a
sibling adapter to `lib/providers/twilio.ts` — the call-placing surface is small
(`dialLeadTwiML`, `placeCall`, the recording + dial-result webhooks), so it is contained,
but it is a real integration and needs credentials to build against.

**Whichever number ends up dialling, register it with Truecaller Business** and let it warm
up. A new number making dozens of calls a day gets flagged on reputation alone.

**Note the operational consequence:** patients now ring back **+91 77100 70566**, a
physical clinic phone — not the CRM. Nothing about that call is logged, recorded or
attributed. Inbound routing into the CRM (flow 11) is a separate, still-unconfigured
feature (`TWILIO_INBOUND_NUMBER` is unset).
_Added 2026-09-03; caller ID configured locally 2026-09-04._

### 🔴 Merge the duplicate lead records (data, not code)
Testing surfaced **seven lead records on one phone number** (`+919536108238` — `fahar` ×4,
`Dr.Asif`, `asif`). Inbound WhatsApp replies route to the *oldest* record, which is why replies
looked missing. The code now shows one shared conversation on every record and flags the
siblings — but the duplicates themselves still split quotes, calls and ownership across seven
rows, and every report counts them as seven people.

**Someone has to merge them** (open a duplicate → its Merge control), choosing which name, owner
and stage survive. Worth checking production for other numbers in the same state:
```sql
SELECT right(regexp_replace(phone,'\D','','g'),10) AS last10, count(*), string_agg(name,' | ')
FROM "Lead" WHERE "deletedAt" IS NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC;
```
Also unresolved: **what created them**. Dedup exists (`duplicateOfId`) but these got through, so
intake has a gap worth finding before the merge is undone by new duplicates.
_Added 2026-09-01._

### 🟠 `fresh_inquiry` — a lead stage that isn't in `LEAD_STAGES`
7 local leads carry `stage = "fresh_inquiry"`, which no longer exists in `lib/leadStages.ts`
(a past migration was meant to convert them to `ai_contacted` — see CHANGELOG 2026-08-11).
`stageRank()` falls back safely so reports and SLAs behave, but `stageLabel()` renders the raw
key, now visible in the duplicate banner. Either finish the migration on the rows or add the
stage back deliberately (it's the same decision as the "Fresh Lead default stage" item below).
**Check production for the same rows.** _Added 2026-09-01._

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

### 🟠 Twilio `checkTwilio` polish — distinguish auth-fail/suspension from outage (optional)
The root cause of the earlier "Twilio API down" alerts turned out to be **account suspension
for non-payment**, not a bad token — the stored `TWILIO_AUTH_TOKEN` was valid all along. Once
funds were added the probe returned `HTTP 200 / status active` (resolved 2026-08-11). Remaining
*optional* polish: make `checkTwilio` (`lib/healthMonitor.ts`) report a `401 / error 20003` as
"auth failed / account suspended (billing)" distinctly from a real outage, so the next
occurrence is self-explanatory in Slack instead of reading as a generic HTTP 401.
_Added 2026-08-08; credential/suspension resolved 2026-08-11._

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

### Pre-delivery QA — deferred items (batch 2+)
From the 2026-08-11 QA pass. The **batch-1 quick wins shipped** on `dev` (commit `a4194c5`:
dark-mode selects, quote-revision audit, mandatory quote source, AI-skips-voice-notes, call
button on new leads, Interest→Treatment + Callback→Follow Up renames, Created column). Still
open:
- **"Fresh Lead" default stage (M — needs a prod migration).** Every lead is currently born
  `ai_contacted` (`schema` default + `DEFAULT_STAGE`). Decision made: add a `fresh_lead` stage
  as the default and advance to `ai_contacted` **only when the AI actually places a call**
  (add the transition in `lib/callIntake.ts`). Touches `lib/leadStages.ts`, schema migration,
  and call-outcome stage mapping.
- **Lead creation-date filter (M).** `LeadsTable` has only enum/text filter kinds; add a
  date-range kind (the Created column now exists to filter on).
- ~~**Editable Follow-Up date (M).**~~ **Done 2026-09-01** — a date+time field on the lead
  retargets the step the leads table reads (`setLeadFollowUp`), IST wall-clock, audited. See
  [flows/01-lead-intake.md](flows/01-lead-intake.md). Raised by the business in testing.
- **Tags dropdown (deferred by user).** `lead.tag` is free text; convert `TagField` to a
  select once the **preset tag list is provided**. No preset list exists yet.
- **Interest/Treatment auto-fill (M).** Transcript-derived treatment currently lands in `tag`,
  not `interest`; decide source-of-truth (transcript vs campaign→treatment map) and wire the
  write-back in `lib/callIntake.ts` / intake.
- **Bulk select / bulk update leads (L).** No multi-select or bulk-action UI in `LeadsTable`;
  needs selection state + a bulk-action bar + new bulk server action(s) with per-lead auth.
- **AI First Inbound Response — global on/off toggle (M).** There is no LLM; "AI inbound" is the
  deterministic chatbot-flow engine (`lib/chatbotRuntime.ts`), gated only by per-flow `active`.
  Add a persisted global setting + a toggle in the (currently stub) `settings` page, read before
  `runChatbot` in the WhatsApp webhook.
- ~~**Reports module (L).**~~ **Done 2026-08-30** — `/reports` with the ten-report set and a
  shared IST date range. See [flows/12-reports.md](flows/12-reports.md). **Not built:** CSV/PDF
  export, and branch filtering (the reports are clinic-wide; every role that holds
  `reports.view` already sees all leads, so scoping wasn't forced — revisit if a branch manager
  should only see their own branch's numbers).
- **Quote treatment catalog — mostly done (correction).** Verified 2026-08-11: the catalog IS
  populated in prod AND local (371 items = 182 services + 189 packages from `data/catalog.csv`),
  so quote creation is **NOT blocked**. Still deferred (needs source data + decisions, not just a
  re-run): (1) the **Campaigns sheet** (Bridal / Anti-Ageing / Groom tiered option bundles) — a
  different shape needing its own import mapping + likely a new catalog `type`; (2) **4 skipped
  package rows** — 1 duplicate name collapsed by the (type,name) unique key + 3 no-fixed-price
  "budget-envelope" wrappers. See [[cara-catalog-deferred]]. Also still open: no free-text quote
  fallback and no catalog admin UI (both nice-to-haves, not blockers).
- ~~**Quote WhatsApp-share disabled (config).** Enabled only when the 24h window is open OR
  `QUOTE_DOC_TEMPLATE_NAME` is set.~~ **Done locally 2026-08-22** — the WABA already has an
  APPROVED `quote_document` (en) template with a DOCUMENT header, so `.env.local` now sets
  `QUOTE_DOC_TEMPLATE_NAME=quote_document` / `QUOTE_DOC_TEMPLATE_LANG=en` and a quote can be
  shared on a closed window. **Still to do: set the same two vars in the Railway environment**,
  or proactive quote sharing stays disabled in production.
_Added 2026-08-11._

---

## Post-sales spec — deferred from the ERP core build

The post-sales ERP core shipped 2026-08-18 (see
[flows/09-post-sales-journey.md](flows/09-post-sales-journey.md)). These items are from the
**same spec section** and were explicitly scoped to the following commit — they are the
rest of "Connecting to Calendar and Billing", not new ideas.

- **Post-sales WhatsApp templates (BLOCKER for automation) (S).** The engine, schedule and
  coordination are live, but no approved template exists for day 1/7/30/90, so every
  check-in lands as a human task. Needs four templates submitted to Meta, then
  `POSTSALES_TEMPLATE_CHECKIN_D1|D7|D30|D90` set and `POSTSALES_CHECKINS_ENABLED=true`.
  Template body vars are `{{1}}` first name, `{{2}}` procedure, `{{3}}` "day N".
- **Calendar & appointments (L).** Booking link showing **real** availability (no
  double-booked slot); a booking auto-updates the CRM (stage move, counsellor assigned,
  campaign messages cancelled); the appointment is **linked to a quote** where one exists,
  so a first consultation is distinguishable from a pre-op visit for a specific procedure;
  confirmation + a 24h and a 2h reminder; a no-show flags the lead, creates a task, and
  drops them into a gentle follow-up. Relates to the older **F3** gap in
  `gaps-and-roadmap.md` ("no structured appointment / no-show handling").
- **Billing → CRM sender not wired (M) — ON HOLD 2026-08-30.** The receiving end is
  built and live (`POST /api/webhooks/invoice`), but nothing calls it: no billing
  integration exists, so in practice invoices only arrive via the admin's by-hand entry.
  Two things to settle before building it: (1) **which system raises the invoices** and
  whether it can send webhooks or must be polled; (2) **how an invoice names its quote** —
  billing doesn't know our cuid, and a patient can hold two quotes, so matching on
  name/amount would eventually credit the wrong branch. Cheapest bridge: accept the quote
  reference already printed on the PDF (`Q-6Y16MJ`) typed into the billing system's
  reference field, and look the quote up from that. Adapter pattern to copy:
  `app/api/intake/meta` / `google`.
- ~~**Invoice webhook — "converted" means an invoice exists (M).**~~ **Done 2026-08-30** —
  `POST /api/webhooks/invoice` + the `Invoice` model attached to the quote; conversion by
  hand is refused without one (admin override records a real invoice with a reason). See
  [flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md) §billing. **Production needs
  the billing system pointed at the endpoint with `WEBHOOK_SECRET`.** Original design: an
  authenticated `/api/webhooks/invoice` plus an `Invoice` model attached to the **quote**
  (never the lead), so billing tells the CRM which branch invoiced and nobody types it.
  The journey trigger is already decoupled — it fires on the quote reaching `converted`
  however that happened — so this slots in without touching the ERP. **The CRM stores no
  card or bank details, ever.**
- ~~**Branch credit + 7-day dispute (M).**~~ **Done 2026-08-30** — credit follows the
  invoice (nothing to type), one dispute per quote inside 7 days, Sales Head decides once
  and finally, upholding is the only way a credit moves. See
  [flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md) §branch credit. Not built: a
  standing review queue for the Sales Head — disputes surface on the quote and as a bell,
  which is enough at current volume.
- ~~**Ad-spend import (M).**~~ **Done 2026-08-30** — the `AdSpend` table, `scripts/importAdSpend.ts`
  (CSV, with `--zero-fill`) and `POST /api/webhooks/ad-spend`. A missing day is **"unavailable"**
  and withholds every cost figure covering it; a genuine no-spend day must be imported as an
  explicit 0. See [flows/12-reports.md](flows/12-reports.md) §ad-spend. **Still to do in
  production:** point a daily job at one of the two intake paths — nothing imports automatically,
  so until someone schedules it the Source Attribution cost columns stay unavailable.
- **Post-sales branch scoping (S).** The board filters by branch but doesn't restrict:
  any `postsales.manage` holder can act on any branch's journey. Decide whether clinical
  staff should be branch-scoped like leads are.
- **Post-sales overdue escalation ladder (S).** One Slack alert per stall, no second
  reminder and no manager escalation (the handover SLA has both). Reuse `lib/handoverSla.ts`
  shape if the clinic wants it.
- **Treatment→policy matching from the catalog (S).** `resolveTreatmentType()` keyword-matches
  the quote's free text; reading `CatalogItem.category` would be more reliable. Falls back
  to `default` safely today.

_Added 2026-08-18._

---

## Done
_(nothing yet — move completed items here with the date + commit)_
