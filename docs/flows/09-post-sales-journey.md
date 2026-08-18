# 09 — Post-sales journey / ERP (§post-sales)

Where the clinic side of the house lives: doctors, the OT team, post-sales consultants
and the front desk. Sales ends at "an invoice exists"; everything after it happens here.

> **This build ships the ERP core.** Calendar/appointments, the invoice webhook that
> drives conversion, branch-credit disputes and the ad-spend import are the next commit
> — see [Not in this build](#not-in-this-build).

## The one structural rule

**A journey attaches to a converted QUOTE, never to a lead.**

A patient who converts a hair transplant *and* a PRP course has **two journeys**, running
at their own speeds, with their own stage clocks and their own check-in schedules. The
lead is the person; the quote is the treatment; the journey is that treatment's care.

Enforced by the database: `PostSalesJourney.quoteId` is `@unique`, so a second journey on
one quote is structurally impossible, and a journey with no quote cannot exist.

## The six stages

`converted → pre_op → surgery_done → post_op_followup → recovery_monitoring → closed_successfully`

Keys and labels: [lib/postSales/stages.ts](../../lib/postSales/stages.ts).

The spec's alternative route (*Consultation Done → Converted → …*) is the **lead's** path
into conversion, not an extra journey stage — "Consultation Done" lives on `Lead.stage`.
Both routes land the journey at `converted`.

| Rule | Where |
|------|-------|
| A journey opens automatically the moment a quote hits `converted` | `transitionQuote()` → `openJourneyForQuoteSafe()` |
| Forward moves are one click; a **backward** move needs a written reason | `moveJourneyStage()` |
| Entering `surgery_done` **requires** the surgery date | `moveJourneyStage()` |
| The surgery date **anchors** the whole check-in schedule | `scheduleCheckIns()` |
| Every move re-arms the stage clock and clears the overdue dedup | `moveJourneyStage()` |

### Who owns the stages

**The post-sales team owns them. Sales counsellors can't edit them.** That is the
capability split, not a UI convention:

| Capability | Who holds it | What it does |
|---|---|---|
| `postsales.view` | front desk, telecaller, telecalling head, branch manager, sales head, **all three clinical roles** | See the board, a journey, the handover summary |
| `postsales.manage` | **doctor, ot_team, post_sales_consultant**, branch manager, admin | Move stages, assign the team, record the surgery date |
| `postsales.checkins` | doctor, post_sales_consultant, **front desk**, branch manager, admin | Resolve / reschedule a care check-in, write journey notes |
| `postsales.policy` | branch manager, admin | Edit the per-treatment stage limits |

A counsellor reaching `/post-sales` sees a read-only board with a banner saying so.

### The clinical roles see the summary, not the recordings

`doctor`, `ot_team` and `post_sales_consultant` are **not granted `leads.view` or
`calls.view`**. `/leads` and `/calls` are now capability-gated in `routeCapability()`, so
there is no route from the ERP to a call recording, a transcript or a CQS score at all.
The handover summary is their entire view of the patient — which is the spec's
requirement, expressed as access control rather than as a hidden button.

Two supporting pieces make that safe:

- `leadScope()` lists the clinical roles as `own`-scoped, so if an admin ever grants one
  `leads.view` from the Hierarchy screen they'd see only leads they own (none) rather
  than the whole patient database.
- The route guard's denial fallback is `landingPath(role)`, which resolves to
  **`/no-access`** when a role can't reach its own landing page. Without that, gating
  `/leads` would have bounced a doctor between `/leads` and the redirect forever.

## Time limits per stage, per treatment type

"Hair transplant recovery is not PRP recovery. Overdue = alert."

A quote's free-text treatment is resolved to a stable **policy key** by keyword
([lib/postSales/policy.ts](../../lib/postSales/policy.ts)) — `hair_transplant`, `prp`,
`skin_procedure`, `surgical_other`, or `default`. The key is **snapshotted onto the
journey** at handover, so a later policy rename can't silently re-time a journey in
flight.

Built-in defaults (live from day one, editable at `/post-sales/policies`):

| Policy | converted | pre_op | surgery_done | post_op_followup | recovery_monitoring | check-ins |
|---|---|---|---|---|---|---|
| `hair_transplant` | 3d | 21d | 2d | 14d | 120d | 1, 7, 30, 90 |
| `prp` | 3d | 7d | 1d | 10d | 45d | 1, 7, 30 |
| `skin_procedure` | 3d | 10d | 1d | 10d | 60d | 1, 7, 30 |
| `surgical_other` | 3d | 21d | 2d | 21d | 90d | 1, 7, 30, 90 |
| `default` | 3d | 14d | 2d | 14d | 90d | 1, 7, 30, 90 |

A stage with **no** limit never goes overdue — that's how `closed_successfully` is
expressed. `stageDays` is JSON, so every read narrows it (`parseStageDays`): known stage
keys, positive whole days, anything else dropped rather than trusted.

**Overdue → alert.** `runPostSalesSlaScan()` ([lib/postSales/sla.ts](../../lib/postSales/sla.ts))
polls for live journeys past `stageDueAt`, writes a `postsales.stage.overdue` audit row and
Slacks the accountable person (consultant → doctor → the post-sales channel).
`overdueNotifiedAt` dedups so **one stall produces one alert**; a stage move clears it so
the next stall alerts afresh.

The same pass runs `reconcileMissingJourneys()` — any converted quote with no journey gets
one. That closes the gap the spec flags as *"the single most likely bug in the whole
change"*: a crash between committing the conversion and inserting the journey can't leave
a paying patient outside the clinical pipeline.

## Care check-ins — day 1, 7, 30, 90

[lib/postSales/checkins.ts](../../lib/postSales/checkins.ts). Two things make these
different from the sales follow-up campaigns (flow 8):

### 1. They are medical messages, not marketing

Governed by **clinical** consent, which is a separate field from marketing consent:

| Signal | Effect on a care message |
|---|---|
| `Lead.optedOut` (marketing opt-out) | **Ignored** — care messages still go out |
| `Lead.consentMarketing = false` | **Ignored** |
| The 12-in-30 marketing ceiling | **Not counted against** |
| `Lead.consentClinical = false` | **Blocked** — needs a person |
| `possibleMinor` / `legalThreatFreeze` / `complaintOpen` / deleted | **Blocked** — needs a person |
| Branch quiet hours | **Deferred** within the day |

`consentClinical = null` (the normal case) means *assumed*: a patient with a converted
quote is under the clinic's care. Only an explicit `false` withholds.

The bypass is a single explicit flag — `SendOpts.clinical` in
[lib/messages.ts](../../lib/messages.ts) — set only by `lib/postSales/`. It skips the
`optedOut` guard and adds a `consentClinical === false` guard in its place.

### 2. Blocked is a task, never a silent drop

A post-op patient must not be quietly forgotten. When a check-in can't be automated — no
approved template configured, a safety flag, clinical consent withheld — the row goes to
**`blocked`** with a human-readable reason and stays on the journey page and the board
until someone closes it out ("Done by hand" / "Skip" with a reason). The same is true of a
send that fails three times (`failed`).

### The coordination rule

> 🎨 *The patient sees one relationship, not two. All their check-in messages come from one
> place, coordinated, never overlapping on the same day.*

**At most one care message per patient per IST day, across every journey they have
running.** Two schedules *will* collide — a transplant's day-7 and a PRP course's day-1
land on the same morning — and two systems messaging one patient about two procedures is
exactly what makes a clinic look disorganised.

How it works in `runCheckInTick()`:

1. Due rows are fetched **ordered by `dayOffset` ascending**, so the clinically closer
   check-in is processed first.
2. A per-patient ledger of IST day-keys is seeded from care messages already sent in the
   last 24h — a worker restart mid-morning can't double up.
3. The first check-in for a patient claims the day; every other one for that patient is
   pushed to tomorrow's send hour with `deferredReason` recorded and shown in the UI.
4. The day-key is the day the message **actually goes out**, not the day it was scheduled
   for — otherwise two rows that fell overdue on *different* days would carry different
   keys and both fire this morning.
5. `deferrals` caps the pushing at 7, after which it becomes a human task rather than
   sliding forever.

Care messages go at `POSTSALES_CHECKIN_HOUR_IST` (default **10:00 IST**) — mid-morning, not
whenever a row happens to become due.

## The handover summary

[lib/postSales/handover.ts](../../lib/postSales/handover.ts). Generated **per converted
quote** and snapshotted onto the journey (`handoverSummary` JSON + `handoverGeneratedAt`)
as a permanent record of what was handed over.

The journey page **recomputes it live**, because two parts are volatile and must be
current for a clinician: the patient's **safety flags** and **which other quotes are open**
on this person.

Contents: patient + phone · the specific procedure and session number · price / total /
discount · **which branch invoiced** (and a plain "not reported by billing" when billing
hasn't said, rather than passing the quoting branch off as fact) · language · clinical
consent state · communication preferences · safety flags · counsellor notes · attribution ·
every other quote on the patient · who sold it.

Deliberately absent: `Call.transcript`, `Call.recordingUrl`, CQS. Nothing in the module
reads them.

## Unlocking a converted quote

"Only the Admin can unlock a converted quote, with a written reason in the permanent log."

`unlockLeadQuote` already required `quotes.unlock` (admin-only via the wildcard) and a
reason, but only wrote a Winston line — **which is not a permanent log**. It now writes a
`lead.quote.unlock` audit row carrying the reason, the prior status and the journey it
affects.

The journey is **not** torn down on unlock — care already given is a record. The journey
page shows a banner so the clinical team knows the commercial record is being edited under
them.

## Data model

| Model | Purpose |
|---|---|
| `PostSalesJourney` | One per converted quote. Stage + clock, the clinical team (3 staff logins), surgery date, branch snapshot, handover snapshot |
| `PostSalesCheckIn` | One scheduled care message. `@@unique([journeyId, dayOffset])` makes generation idempotent |
| `PostSalesNote` | Journey-scoped clinical/admin notes — a transplant note doesn't surface on the same patient's PRP journey |
| `TreatmentStagePolicy` | Per-treatment stage limits (`stageDays` JSON) + `checkInDays` |

New on `Lead`: `consentClinical`, `preferredLanguage`.
**Removed** from `Quote`: `journeyStage` — it was an unwritten scaffold column and would
have been a second source of truth beside `PostSalesJourney.stage`.

Migration: `20260818084432_post_sales_erp`.

## Screens

| Route | Guard | What |
|---|---|---|
| `/post-sales` | `postsales.view` | Board — one card per converted treatment, columns are stages. Filters: my patients / overdue / include closed / branch. Cards surface overdue days, blocked check-ins, safety flags, and **"+N other journeys"** |
| `/post-sales/[id]` | `postsales.view` | Handover summary, stage stepper + clock, team assignment, surgery date, check-in schedule, sibling journeys, notes |
| `/post-sales/policies` | `postsales.policy` | Per-treatment stage limits + check-in days |
| `/no-access` | *(none)* | The always-reachable page the route guard falls back to |

## Configuration

All in [.env.example](../../.env.example) under *Post-sales ERP care check-ins*:

- `POSTSALES_CHECKINS_ENABLED` — **off by default.** Schedules still generate and display;
  nothing sends. Deploying the code cannot message a post-op patient by surprise.
- `POSTSALES_CHECKIN_TICK_MINUTES` (15) · `POSTSALES_CHECKIN_HOUR_IST` (10)
- `POSTSALES_TEMPLATE_CHECKIN_D1|D7|D30|D90|DEFAULT` — unset = that check-in becomes a
  human task
- `POSTSALES_SLA_SCAN_HOURS` (6) · `POSTSALES_CHANNEL`

Worker: two new intervals in [workers/callQueueWorker.ts](../../workers/callQueueWorker.ts)
— the check-in tick and the SLA/reconcile pass.

Backfill for quotes that converted before this existed:

```
npm run backfill:journeys                    # dry run — reports counts + a sample
BACKFILL_APPLY=1 npm run backfill:journeys   # live
```

It opens each journey at `converted` and does **not** invent a surgery date or schedule —
guessing would fire day-1 post-op messages at patients months past it.

## Known limitations

- **No WhatsApp templates are approved yet**, so with `POSTSALES_CHECKINS_ENABLED=true`
  every check-in lands in `blocked` ("no template configured") and waits for a person.
  That's the intended failure mode, but the schedule does nothing automated until Meta
  approves the four templates.
- **Treatment→policy matching is keyword-based** on the quote's free text. A treatment
  name that matches nothing falls back to `default` (safe timings). It does not read
  `CatalogItem.category`, which would be a more reliable signal.
- **Stage limits apply from the next move.** Editing a policy doesn't re-time journeys
  already sitting in a stage; they keep the due date they were given on entry.
- **Branch scoping is display-only.** The board filters by branch, but a journey's branch
  doesn't restrict who can see or edit it — any `postsales.manage` holder can act on any
  branch's journey.
- **The overdue alert has no escalation ladder.** One Slack message to the consultant (or
  the channel) per stall; no second reminder, no manager escalation like the handover SLA
  has.
- **`reconcileMissingJourneys()` is capped at 200 per pass** and runs every
  `POSTSALES_SLA_SCAN_HOURS`; a very large backlog drains over several passes (use the
  backfill script instead).

## Not in this build

From the same spec section, deferred to the next commit (design already settled):

- **Calendar & appointments** — real availability on the booking link, booking → stage move
  + counsellor assign + campaign cancel, quote-linked appointments, confirmation + 24h and
  2h reminders, no-show flag → task → gentle follow-up.
- **The invoice webhook** — an authenticated `/api/webhooks/invoice` plus an `Invoice`
  model attached to the quote, so "converted" is driven by billing telling the CRM which
  branch invoiced instead of a counsellor marking it. The journey trigger is already
  decoupled: it fires on the quote reaching `converted` however that happened.
- **Branch credit disputes** — the 7-day window to dispute with the Sales Head, per quote,
  decision logged.
- **Ad-spend import** — daily import, and "unavailable" rather than zero for a missing day.

The CRM stores no card or bank details, and this build adds none.
