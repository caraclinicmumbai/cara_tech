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

## Key files

- `lib/leadIntake.ts` — `ingestLead`, `NEVER_AUTO_CALL`, `PAUSE_AUTO_CALL_SOURCES`
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
