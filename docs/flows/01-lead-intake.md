# Flow 1 — Lead intake

How a lead enters the system, gets normalised, deduped, vetted, and either enters
the AI calling flow or is held for a human.

## Triggers

A new lead arrives from one of these channels:

| Source key | Channel | Entry point |
|------------|---------|-------------|
| `web_form` | Website contact form (WordPress CF7) | `POST /api/intake/web-form` |
| `facebook` / `instagram` | Meta Lead Ads | `POST /api/intake/meta` (webhook) |
| `google` | Google Lead Form | `POST /api/intake/google` |
| `walk_in` | Front desk / iPad | `/leads/walk-in` → `POST /api/leads/walk-in` |
| `whatsapp` | Cold inbound WhatsApp message | `POST /api/webhooks/whatsapp` (see flow 6) |
| `manual` / `referral` | Staff entry | Dashboard |

## Step-by-step

1. **Adapter normalises the payload.** Each channel has an adapter
   (`lib/providers/meta.ts`, `google.ts`) that maps the provider's shape to a common
   lead, including attribution (`campaign`, `adId`, `externalId`).
2. **`ingestLead` (`lib/leadIntake.ts`)** is the single funnel for all sources. It:
   - **Dedups on `source` + `externalId`** so a provider re-delivery can't double-insert.
   - **Duplicate detection (§3.1.1):** matches an existing lead by **phone only**
     (last 10 digits). Email is intentionally not matched — two leads may share an
     email legitimately. A match is linked via `duplicateOfId`, routed to
     `manual_followup`, and **never auto-called** — a counsellor reviews/merges. The
     duplicate's lead page shows a **Merge** button (`mergeDuplicateLead` action): it
     re-parents the duplicate's calls + messages onto the original, backfills fields
     the original is missing, deletes the duplicate, and opens the survivor.
     **The merged record keeps the ORIGINAL's counsellor** — the person already working
     this patient — even though the re-enquiry was round-robined to whoever was next on
     the rota. The merge control names them up front ("Stays with Rohit — leaves Hero")
     and repeats it in the confirm, because merging takes the lead off the duplicate
     owner's list. Only when the original has no counsellor at all does the duplicate's
     owner carry over (`meta.ownerFilledFromDuplicate` records that in the audit).
   - **Held-for-review (anti-spam):** more than 5 web-form submissions from one IP in
     10 minutes flags the lead `heldForReview` (status `manual_followup`, no AI call).
     A separate hard ceiling (50/10 min) returns HTTP 429 outright.
   - **Consent (walk-in):** walk-in requires `consentMethod`/`consentAt`/`consentBy`
     captured at the desk before the record is created.
3. **Routing decision:**
   - Sources in `NEVER_AUTO_CALL` (e.g. `walk_in`) and held/duplicate leads go to the
     **manual queue** — captured, not dialled.
   - Sources in `PAUSE_AUTO_CALL_SOURCES` (default `facebook,instagram`) are captured
     but **not dialled** (pending Meta App Review).
   - Everything else enters the **AI calling flow** (flow 2): an immediate attempt at
     intake (DND-adjusted).
4. **Attribution surfaces in the UI** — the Meta campaign shows as a column in the
   leads list.

## Ownership at intake

**Every lead gets a telecaller the moment it arrives** — before any AI call, not at
handover. `pickOwnerRep` (`lib/salesReps.ts`) takes the least-recently-assigned active
counsellor (sales heads excluded, `SalesRep.lastAssignedAt` is the rota cursor) and
`assignLeadToRep` records it on the lead + the audit trail as a system assignment.

- Applies to **every** lead — walk-ins, duplicates, held-for-review, and a cold
  WhatsApp enquiry that auto-creates a lead (`findOrCreateLeadByPhone`, flow 6).
- **Presence is a preference, not a filter.** An `available` counsellor is picked
  first; if the whole team is on break/offline the lead still goes to the
  least-recently-assigned active rep. Ownership means "whose lead is this to follow
  up", not "who can answer right now" — an ownerless lead shows up in nobody's *my
  leads* and gives a later handover nobody to notify.
- **No notification fires here.** The counsellor is pinged when the AI hands the lead
  over (flow 4), and that handover goes to **this same owner** rather than picking a
  new one.
- Only an empty roster (no active non-head rep) leaves a lead unowned; that logs a
  warning. `scripts/backfillLeadOwners.ts` assigns any leads already in that state.

## Follow-up dates

Every actively-pursued lead is seeded a dated follow-up ladder at intake
(`seedFollowUpSteps` — AI first call, reconfirmation, counsellor call, WhatsApp,
callback, sales-head review), and call outcomes and stage moves keep it current.

**The steps are scheduling machinery, not a screen.** The interactive roadmap panel
that used to sit on the lead page was removed on request: the desk wanted the dates,
not a checklist to maintain. What's left visible is the **next due step**:

- **Lead page** — a `Follow Up` field: the date and step title, red with "(overdue)"
  once it's past due, plus the patient's own requested callback time underneath when
  they named one.
- **Leads table** — the `Follow up` column, same source (earliest pending step),
  highlighted when overdue.

Nothing else changed: seeding, `applyCallOutcomeToRoadmap`, `applyStageChangeToRoadmap`
and the voicemail "return missed call" step all still run, so the dates stay accurate.
Bringing the panel back is a revert of one commit (`components/FollowUpRoadmap.tsx` +
`app/(dashboard)/leads/followUpActions.ts`).

## Key files

- `lib/leadIntake.ts` — `ingestLead`, `NEVER_AUTO_CALL`, `PAUSE_AUTO_CALL_SOURCES`
- `lib/salesReps.ts` — `pickOwnerRep` (rota) / `assignLeadToRep` (ownership + audit)
- `scripts/backfillLeadOwners.ts` — assign leads that predate ownership-at-intake
- `lib/providers/meta.ts`, `lib/providers/google.ts` — channel adapters
- `lib/rateLimit.ts` — IP throttle / held-for-review counters (Redis)
- `app/api/intake/*` — intake endpoints

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `PAUSE_AUTO_CALL_SOURCES` | `facebook,instagram` | Sources captured but not auto-dialled |
| `WEB_FORM_ALLOWED_ORIGINS` | — | CORS allowlist for the public form |
| `META_APP_SECRET` | — | Verifies Meta webhook signature (X-Hub-Signature-256) |

## Limitations

- **Meta auto-call is paused.** `facebook`/`instagram` leads are stored but not called
  until Meta grants Advanced Access to `leads_retrieval` (App Review pending). They sit
  in the manual queue.
- **CF7 web form can't be origin-gated.** WordPress posts server-to-server, so the
  origin allowlist doesn't apply to it; it relies on a shared secret / honeypot instead.
- **Duplicate detection matches on phone last-10 only** (email is not matched). A
  patient who enquires from a brand-new number won't be linked to their prior record.
- **Held-for-review uses a fixed window count.** The counter is `limit − remaining` over
  a single rate-limit window, not a precise rolling histogram — burst boundaries are
  approximate.
- **The IP throttle is fail-open.** If Redis is unavailable the throttle allows the
  submission through rather than blocking legitimate leads.
