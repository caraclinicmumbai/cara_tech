# Gaps & Roadmap

The known-gaps backlog for the CRM, from a structured audit (2026-06-29) across
three dimensions — security/access-control, reliability/data-integrity, and
compliance/testing/ops. This is the single tracked list; update statuses here as
items are addressed (and keep [CHANGELOG.md](CHANGELOG.md) in step).

**Status:** ✅ done · 🚧 in progress · ⬜ open
**Severity:** 🔴 critical · 🟠 important · 🟡 nice-to-have

> Note: some items are **design decisions** (flagged) rather than defects — e.g. a
> flat "all staff see all leads" access model may be acceptable for a small team.
> Confirm intent before building.

---

## Recommended order

1. **Compliance set** (🔴 legal): recording-consent disclosure + digital-source
   consent + data retention/erasure. *(Items C1–C4.)*
2. **Authorization** (🔴): enforce `role`; decide flat vs. scoped access. *(S1–S2.)*
3. **Harden the open reliability items** (🟠): poison-job alerting, opt-out re-check,
   round-robin race, phone normalization. *(R3–R7.)*
4. **Testing + observability** (🟠): a real test suite; Sentry + external uptime.
5. The 🟡 operational-feature gaps as product needs dictate.

---

## Reliability & data integrity

- ✅ 🔴 **R1 — Webhook idempotency.** Duplicate ElevenLabs/n8n/Twilio webhooks created
  duplicate `Call` rows and re-ran the whole pipeline (paid CQS, duplicate alerts,
  rep re-assignment, re-sent templates). *Fixed `ba6270a`: `@unique` on
  `Call.elevenlabsId` + `providerSid`; `recordCall` + the Twilio recording webhook
  short-circuit on duplicates (P2002 race-safe).*
- ✅ 🔴 **R2 — Non-atomic post-call write.** A crash mid-`recordCall` could leave a
  Call recorded but the Lead un-advanced and no retry scheduled (silent stall).
  *Fixed `ba6270a`: Call + Lead in one `$transaction`; side-effects deferred to after
  commit.* Residual: a crash between commit and scheduling can still drop a retry job
  (surfaces via stuck-in-stage / unreachable).
- ✅ 🔴 **R3 — Attempt-count inflated by handover rows.** `human_handover` recordings
  counted toward the retry ladder → `NaN` delays / premature `unreachable`.
  *Fixed `ba6270a`: count AI call types only.*
- ⬜ 🟠 **R4 — Poison jobs lost silently.** A call-attempt job that fails all BullMQ
  retries (e.g. n8n down >~2 min) is dropped with only a log line — the lead is never
  retried and never marked unreachable. (`lib/queue.ts`, `workers/callQueueWorker.ts`)
  → On final failure, alert Slack and/or drop the lead into the manual queue; add a
  dead-letter path.
- ⬜ 🟠 **R5 — `optedOut` not re-checked in `recordCall`.** If a lead opts out (STOP)
  between a call being placed and the result arriving, the post-call pipeline still
  advances stage, schedules the next attempt, and sends templates. (`lib/callIntake.ts`)
  → Early in `recordCall`, if `lead.optedOut`, persist the Call but skip
  outreach/retry/handover.
- ⬜ 🟠 **R6 — Round-robin rep assignment race.** `pickNextRep` does read-then-update
  without a lock; two concurrent handovers can pick the same rep. (`lib/salesReps.ts`)
  → Single transaction with `SELECT … FOR UPDATE SKIP LOCKED`, or atomic
  `updateMany`-returning.
- ⬜ 🟠 **R7 — Phone matching is substring (`contains` last-10).** Two numbers sharing
  a 10-digit tail can cross-match → an inbound message or opt-out routed to the **wrong
  patient**. (`lib/messages.ts`, `lib/leadIntake.ts`) → Store a normalized E.164 /
  `phoneLast10` column and match on equality.
- ⬜ 🟠 **R8 — `optOutLeadsByPhone` non-transactional, partial failure swallowed.** A
  throw mid-loop opts out some leads but not others; the webhook still ACKs 200 →
  compliance risk (lead believes they opted out, still gets called). (`lib/leadIntake.ts`)
  → `updateMany` + cancel jobs; surface failures.
- ⬜ 🟡 **R9 — `status`/`stage`/`source`/`outcome` are free-form strings.** No DB enum
  or check constraint; a typo silently breaks index-driven dashboard filters.
  (`prisma/schema.prisma`) → Convert to Prisma enums / CHECK constraints.
- ⬜ 🟡 **R10 — CQS call has no timeout and blocks the webhook.** A slow Anthropic call
  delays the webhook response → provider timeout → retry (now deduped, but still wasteful).
  (`lib/cqs.ts`, awaited in `lib/callIntake.ts`) → Set client `timeout`/`maxRetries`;
  consider moving scoring off the synchronous path.
- ⬜ 🟡 **R11 — Digest/SLA minor issues.** Digest window keys off wall-clock `now`, so a
  delayed run can skip/mis-window a day (`lib/digest.ts`); per-lead `count` N+1 in the
  pending-SLA scan; missing composite index on `needsHandover, handoverAt`; silent no-op
  when a WhatsApp status webhook hits an unknown `waId` (`lib/messages.ts`).

## Security & access control

- ⬜ 🔴 **S1 — `role` is defined but never enforced.** `admin`/`sales` is on the session
  but no route/action/middleware checks it; every authenticated user can hit every
  operation including Settings and template creation. (`auth.ts`, all of `app/(dashboard)`)
  → Add a `requireAdmin()` guard; gate admin/destructive surfaces.
- ⬜ 🔴 **S2 — No per-record scoping (IDOR).** *(Possible design decision.)* Any logged-in
  user can read/mutate any lead, play any recording, read any transcript, and send
  WhatsApp on any lead — `assignedRepId` exists but no query filters on it.
  (`app/api/leads`, `app/api/calls`, `leads/actions.ts`, recording/media proxies)
  → Decide all-staff-see-all vs. assignment-scoped; if scoped, filter every query/mutation.
- ⬜ 🔴 **S3 — `/api/twilio/voice/[leadId]` is unauthenticated + XML injection.** No
  signature check; returns the patient's raw phone in TwiML built with unescaped values.
  (`app/api/twilio/voice/[leadId]/route.ts`, `dialLeadTwiML` in `lib/providers/twilio.ts`)
  → Verify `X-Twilio-Signature`; XML-escape all interpolated values.
- ⬜ 🟠 **S4 — ElevenLabs webhook has no replay/timestamp check.** HMAC authenticates `t`
  but it's never validated as recent → a captured request can be replayed. (`lib/providers/elevenlabs.ts`)
  → Reject when `|now − t| > ~5 min`.
- ⬜ 🟠 **S5 — Rate limiters fail-open + IP spoofable.** A Redis outage silently disables
  login brute-force + intake throttle; `getClientIp` trusts the first `x-forwarded-for`,
  so rotating the header bypasses both. (`lib/rateLimit.ts`, `lib/loginThrottle.ts`)
  → Trust the platform's real client IP; consider fail-closed (or a global cap) for login.
- ⬜ 🟠 **S6 — Public web-form has no CAPTCHA; origin allowlist defaults to allow-all.**
  Unauthenticated endpoint that writes PII and can drive paid AI calls; honeypot is the
  only bot control. (`app/api/intake/web-form/route.ts`) → Add Turnstile/CAPTCHA; require
  the origin allowlist in production.
- ⬜ 🟡 **S7 — Minor:** Google intake parses body before checking the shared key; webhook
  error responses echo Zod `flatten()` internals to external callers; WhatsApp cold-inbound
  can auto-create unbounded leads from any number. → Auth-before-parse; generic 400s
  externally; rate-cap cold-lead creation.

## Compliance (DPDP / India)

- ⬜ 🔴 **C1 — No recording-consent disclosure on AI calls, and consent never stored.**
  The ElevenLabs call has no spoken "this call is recorded" disclosure, and no field
  records that consent was given. Recording a patient (health context) without disclosure
  is real exposure under DPDP. (`lib/providers/elevenlabs.ts`, n8n Agent 1)
  → Add a spoken disclosure as the agent's first line; persist a per-`Call` consent flag.
- ⬜ 🔴 **C2 — Digital-source consent not captured.** `consentMethod/At/By` are populated
  only for walk-ins; web/Meta/Google leads get a paid AI call with no consent record.
  (`lib/leadIntake.ts`, `app/api/intake/*`) → Capture the ad-form/website consent text +
  timestamp at ingest.
- ⬜ 🔴 **C3 — No data retention / purge / right-to-erasure.** Transcripts, recordings, and
  PII are stored forever; no admin "delete this patient's data" action; a deletion request
  can't be honored without manual DB surgery. → Admin hard-delete action (cascades) + null
  the Twilio recording; scheduled purge past a retention window.
- ⬜ 🟠 **C4 — DND is a time-window only (no TRAI/DLT scrub).** Quiet hours (22:00–10:00 IST)
  are enforced, but there's no check against the DND registry / DLT-registered templates.
  (`lib/callWindow.ts`) → Integrate a DND-scrub before dialing. *(Known; parked pending a
  DLT-registered provider.)*
- ⬜ 🟠 **C5 — WhatsApp opt-out is narrow + English-only; consent-"YES" is a TODO.** Exact-match
  on `["stop","stop messages","unsubscribe"]`; no opt-out confirmation; the consent-YES branch
  is unimplemented. (`app/api/webhooks/whatsapp/route.ts`) → Broaden/multilingual matching,
  send a confirmation, finish the consent flow.

## Testing & observability

- ⬜ 🟠 **T1 — No automated tests at all.** No runner, no tests, no CI — for a system placing
  real paid calls and sending real messages. The DND + attempt-ladder math is exactly the
  off-by-one-prone logic that needs coverage. (`package.json`) → Add Vitest; unit-test
  `callWindow`, the attempt ladder, opt-out suppression, dedup. *(`playwright` is installed
  but unused — wire up e2e too.)*
- ⬜ 🟠 **O1 — No error tracking / external uptime / documented backups.** No Sentry; the
  health monitor runs inside the worker so can't catch total-platform downtime; no DB-backup
  runbook. → Add Sentry; **external uptime check** on `/login` *(already a tracked follow-up)*;
  document Railway/Postgres backups + an incident runbook.
- ⬜ 🟠 **O2 — No audit trail.** Stage/status changes, message sends, and **recording access**
  are logged to ephemeral Winston only — no per-lead, queryable record of who did/saw what.
  For health data, "who listened to this recording" is a baseline requirement.
  → Add an `AuditLog` model written on stage changes, sends, deletions, and recording access.
- ⬜ 🟠 **O3 — No global kill-switch.** `PAUSE_AUTO_CALL_SOURCES` is per-source only; no single
  switch to halt all outbound calls + messages during an incident. → A global
  automation-enabled flag checked before any send/dial.

## Operational features (product)

- ⬜ 🟡 **F1 — No staff/user or sales-rep management UI.** Settings is a placeholder;
  `User`/`SalesRep` rows must be created via Prisma Studio/seed. → Admin CRUD for users + reps.
- ⬜ 🟡 **F2 — No reporting/export.** Live counts only; no CSV export, no win/loss report beyond
  the daily Slack digest. → CSV export of leads/calls with date filters.
- ⬜ 🟡 **F3 — No structured appointment / no-show handling.** Reschedule is modeled as a
  callback; no appointment datetime field, no no-show state, no pre-appointment reminder.
- ⬜ 🟡 **F4 — Test/demo data has no cleanup path.** No tagging/sweep to distinguish seeded
  data from production once real patient data coexists.
- ⬜ 🟡 **F5 — No payment/quote/invoice capture.** A `price_request` handover trigger exists
  but nothing records quotes/payments. *(Likely out of scope for the sales layer — noted.)*
