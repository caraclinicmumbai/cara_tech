# Documentation changelog

Updated with every commit merged to `main`. Each entry: date, commit, what changed,
and which flow doc(s) were updated.

Format: newest first.

---

## 2026-07-15 — Phase 2 foundations: multi-quote model + pipeline cutover

**The structural change (§multi-quote):** a lead is the *person*; a **Quote** is the
*treatment*. One lead holds many quotes, each converting on its own. The lead never
"converts" — it summarises its quotes ("2 quotes — 1 converted, 1 open").

**Schema (additive, applied to prod):** `Quote` + `QuoteVersion` (price history),
`Branch` scaffold + nullable `branchId` on Lead/SalesRep/User (one branch for now),
call-blocking **protection flags** on Lead (possibleMinor, hearingImpaired,
legalThreatFreeze, complaintOpen), **per-channel consent** (consentCall/consentMarketing
+ DND cache), and an append-only **AuditLog** (prevHash/hash chain). Nothing wired to the
flags/consent/audit yet — schema only.

**Multi-quote layer:** per-lead **Quotes** panel — raise a quote (treatment/price/source),
revise price (new version; old kept + marked replaced), advance through the lifecycle,
convert (locks the quote, never the lead), admin-only unlock. Rules enforced in
`lib/quotes.ts`: one OPEN quote per treatment, auto cycle numbering, lock-on-convert.
Actions in `app/(dashboard)/leads/quoteActions.ts` (capability + lead-ownership checked).
Caps: `quotes.view/manage/convert` for telecaller/branch_manager/sales_head;
`quotes.unlock` → crm_admin only.

**Pipeline cutover:** `converted` removed from the lead stage list — the person-track now
ends at *Consultation Done*. Stuck-stage SLA is quote-aware (skips a lead with a WON
quote). One-time idempotent backfill in `scripts/backfillConvertedQuotes.ts`; the prod run
was a **no-op** (0 leads had reached the converted stage).

Files: `prisma/schema.prisma`, `lib/{quotes,quoteStages,leadStages,stageSla,rbac}.ts`,
`app/(dashboard)/leads/{quoteActions.ts,[id]/page.tsx}`, `components/QuotesPanel.tsx`,
`scripts/backfillConvertedQuotes.ts`. Flow docs: see `flows/` (quote lifecycle to be
expanded as the quote UI/reporting grows).

## 2026-07-14 — RBAC Phase 4: admin UI for users, roles & rep roster

New **/users** screen (CRM-Admin only, `users.manage`): create staff logins, set roles,
link a login to a sales-rep identity, reset passwords, delete logins — plus a **sales-rep
roster** section (`reps.manage`) to add reps (name/phone/Slack id), toggle active, and
flag sales-head. Guards: can't demote/delete the last CRM Admin or yourself; a rep links
to at most one login. Files: `app/(dashboard)/users/{page,actions}.tsx`,
`components/UsersAdmin.tsx`. Replaces script-based user seeding.

## 2026-07-14 — RBAC Phase 2+3: ownership + enforcement

**Ownership (Phase 2):** every new lead (incl. walk-ins) is now assigned round-robin to
a telecaller at intake — its owner — with **no notification** (`lib/leadIntake.ts`). AI
call flow unchanged. Handover now notifies that **existing owner** instead of
re-assigning (`lib/handover.ts`, `getLeadOwner`). Staff-entered leads stamp
`createdById`.

**Enforcement (Phase 3):** `can(role, cap)` is now enforced at every layer —
- **Server actions** (`leads/actions.ts`): each gated via `requireCapability` (editStage,
  markLost, editTag, call, whatsapp, merge, softDelete, restore, permanentDelete).
- **API routes**: `/api/leads` (create/view) + `/api/leads/walk-in` via `requireApiCapability`.
- **Route guard** (`auth.ts` + `routeCapability`): bounces users lacking a page's
  capability (dashboard/cqs→analytics, templates, settings, users, deleted→restore,
  walk-in→walkin) to /leads.
- **Ownership scoping** (`leadWhereForUser` / `canSeeLead`): front-desk/telecaller see
  only leads they own or created — on /leads, lead detail (404 otherwise), and /calls.
- **UI hiding**: nav links, the "New lead" form, the row Delete button, and permanent-
  delete are hidden per capability. Role label shown in the header.

## 2026-07-14 — RBAC Phase 1: roles + permission model (foundation)

Foundation for role-based access (no enforcement yet — that's later phases). New
`lib/rbac.ts`: five roles (`front_desk`, `telecaller`, `branch_manager`, `sales_head`,
`crm_admin`), a central capability map, `can(role, cap)`, and `leadScope(role)`
(front-desk/telecaller = own, others = all). `lib/authz.ts` bridges the session:
`currentUser` / `requireCapability`. The session/JWT now carry `role` + `salesRepId` +
`id`. Schema: `User.salesRepId` (unique, ↔ `SalesRep.user`), `Lead.createdById`, and
`User.role` default → `telecaller`. Migrated the existing admin login `admin` →
`crm_admin` in prod. Enforcement, ownership assignment, and the admin UI follow in
Phases 2–4.

## 2026-07-10 — New lead pipeline stages + Lost preset tags

Reworked the pipeline to: **AI Contacted → AI Attempted—Unreachable → Communication
Not Established → Human Callback Pending → In Consideration → Appointment Scheduled →
Consultation Done → Converted → Lost**. All are auto-advanced (forward-only) by call
events and manually editable. Auto-mapping in `recordCall`: handover → Human Callback
Pending; `confirmed` → Appointment Scheduled; call-later → Communication Not
Established; retries exhausted → AI Attempted—Unreachable; `not_interested` = opt-out
only (no stage move). New leads default to *AI Contacted*.

**Lost** now takes a **preset tag** (11 options: Not interested, Enquired for different
product, Wrong number, Pricing issue, Enquired for competitor, Did not enquire, Chose
competitor, Location issue, Clinic staff, Nonsense, Other) via a modal, plus an
**optional review** (required only if no tag is picked). Schema: new `Lead.lostTag`;
default stage → `ai_contacted`. Existing leads migrated (`fresh_inquiry`→`ai_contacted`,
`existing_followup`→`consultation_done`, `converted_followup`→`converted`). Files:
`lib/leadStages.ts`, `lib/callIntake.ts`, `components/StageSelect.tsx`,
`app/(dashboard)/leads/actions.ts`. Updated [flow 3](flows/03-post-call-cqs-and-stage.md).

## 2026-07-10 — Duplicate detection: phone-only (email no longer matched)

`findDuplicateLead` now matches on **phone (last 10 digits) only**. A shared email no
longer flags a lead as a duplicate — two leads may legitimately use the same email, so
only a repeated phone number marks a duplicate now. File: `lib/leadIntake.ts`; updated
[flow 1](flows/01-lead-intake.md).

## 2026-07-09 — Manual call button available for opted-out leads

Opt-out only suppresses *automated* outreach — a human rep may still need to dial the
lead. The lead-detail **call button** now shows for opted-out leads too (not just
assigned ones), and `callLeadAndRecord` falls back to the least-recently-assigned
active telecaller when the lead has no assigned rep, so the click-to-call works. A
small caption notes automated outreach stays suppressed. Files:
`app/(dashboard)/leads/[id]/page.tsx`, `components/CallButton.tsx`,
`app/(dashboard)/leads/actions.ts`.

## 2026-07-08 — Truncate long Interest in the leads table

The Interest column now truncates to a fixed width with an ellipsis
(`max-w-[200px] truncate`) and shows the full text via a native `title` tooltip on
hover — long values no longer stretch the column. File: `components/LeadsTable.tsx`.

## 2026-07-08 — Soft-delete leads + Deleted (trash) section

Leads can now be deleted from the leads table (🗑 button in a new Actions column) —
a **soft delete**: it sets `Lead.deletedAt`/`deletedBy`, cancels any pending calls, and
moves the lead to a new **Deleted** nav section (`/leads/deleted`), where it can be
**Restored** or **Deleted permanently** (hard delete, cascades calls/messages). Deleted
leads are excluded everywhere: leads list, dashboard counts, dedup, digest, stage-SLA
scan, and the worker's call gate. Schema: additive `Lead.deletedAt` + `deletedBy`
(+ index). New: `softDeleteLead` / `restoreLead` / `permanentlyDeleteLead` actions,
`LeadDeleteButton` / `DeletedLeadActions` components, `/leads/deleted` page, nav link.
Updated [flow 1](flows/01-lead-intake.md).

## 2026-07-08 — Enable voicemail detection on the AI agent (ElevenLabs config)

Enabled the `voicemail_detection` system tool on the agent with an empty
`voicemail_message`, so it **ends the call immediately** when it detects an answering
machine — instead of monologuing to dead air (as happened on lead "Faiz", ~2 min of
paid silence). ElevenLabs-side agent config change (`PATCH /v1/convai/agents/{id}`),
not a code change; documented in
[elevenlabs-agent-integration.md §11](elevenlabs-agent-integration.md).

## 2026-07-08 — Merge button for duplicate leads

The duplicate-lead banner on a lead's detail page now has a **Merge** button. It runs
the `mergeDuplicateLead` server action: re-parents the duplicate's calls + messages
onto the original, re-points any leads that considered it their original, backfills
fields the original is missing (never overwrites), deletes the duplicate, and navigates
to the survivor. Confirmation-gated + session-checked. Files:
`app/(dashboard)/leads/actions.ts`, `components/MergeLeadButton.tsx`,
`app/(dashboard)/leads/[id]/page.tsx`. Updated [flow 1](flows/01-lead-intake.md).

## 2026-07-08 — Play the AI call recording in the CRM

AI (ElevenLabs) calls previously showed only the transcript. The lead-detail call list
now also renders an audio player for AI calls, mirroring the Twilio handover-recording
player. New `fetchConversationAudio()` (`lib/providers/elevenlabs.ts`) pulls the MP3 from
`/v1/convai/conversations/{id}/audio`, served through a session-gated proxy route
(`app/api/elevenlabs/recording/[callId]`) keyed on the stored `elevenlabsId`. Files:
`app/(dashboard)/leads/[id]/page.tsx`.

## 2026-07-07 — Show CQS in the leads table

Added a **CQS** column to the `/leads` table showing each lead's latest scored call's
score as a colour-coded badge (green ≥75, amber ≥50, red <50; "—" when unscored),
matching the lead-detail styling. The leads query fetches the most recent call with a
non-null `cqs` per lead. Filterable like the other enum columns. Files:
`app/(dashboard)/leads/page.tsx`, `components/LeadsTable.tsx`.

## 2026-07-07 — Render all UI timestamps in IST

The servers run UTC, so `toLocaleString()` rendered every user-facing time 5h30m early
(a call placed at 10:02 AM IST showed as "4:32 AM"). New `formatIst()` helper
(`lib/datetime.ts`, `Asia/Kolkata`) now formats every timestamp in the UI — lead detail
(created/updated, handover, callback, lost, opted-out, held), the Calls page, the
Dashboard recent-calls, and the WhatsApp thread — e.g. "4 Jul 2026, 10:02 AM IST". No
calling-logic change; the DND window was already IST-correct, this only fixes display.

## 2026-07-07 — Leads table: remove click-to-sort (keep filters)

Per request, the column headers no longer sort on click — the labels are plain text
again. Per-column filtering (dropdowns / contains) and the name search are unchanged.
File: `components/LeadsTable.tsx`.

## 2026-07-07 — Leads table UI fixes (sticky column + dropdown clipping)

Follow-up to the leads table: (1) the sticky Name column used a translucent header
background, so horizontally-scrolled columns bled through it ("hoName") — made it
opaque; (2) the `overflow-x-auto` scroll container forced `overflow-y: auto`, clipping
filter dropdowns on right-side columns — the filter panel now renders as a fixed,
viewport-clamped layer that can't be clipped; (3) swapped the boxy filter glyph for a
clean `▾` caret. File: `components/LeadsTable.tsx`.

## 2026-07-07 — Leads table: per-column filters, sort, name search; walk-in consolidated

The `/leads` table is now an interactive client component (`components/LeadsTable.tsx`):
a **name search** box up top, **click-to-sort** on every column header, and a
**per-column filter** — a checkbox dropdown of the distinct values for enum-like
columns (Source, Stage, Status, Calls) and a "contains" box for free-text columns
(Phone, Campaign, Tag, Interest). Filters combine (AND) with the search; a live
"N of M" counter and "Clear all filters" reset. Interactive cells (StageSelect,
TagField) still render inline. Separately, the **Walk-in tab** dropped its own
"Recent walk-ins" table — walk-ins already appear in the (now filterable) main list —
leaving just the entry form.

## 2026-07-07 — Global kill-switch to pause automated AI calls

New `AI_CALLS_PAUSED` env flag (`aiCallsPaused()` in `lib/queue.ts`). When truthy,
lead intake captures the lead but places/queues no call (`lib/leadIntake.ts`), and the
worker skips any already-queued retry/callback as it fires (`workers/callQueueWorker.ts`).
Rep-initiated click-to-call is unaffected. Toggle live on Railway — no redeploy.
Updated [flow 2](flows/02-ai-calling-and-retries.md) + `.env.example`.

## 2026-07-01 — Sales-head escalation: CQS-extremes-only, off the rota

The sales head is a manager, not a line telecaller. New `SalesRep.salesHead` flag:
such reps are **excluded from the round-robin rota** (`pickNextRep`) so routine
handovers never route to them, and they're DM'd **only on CQS extremes** — a call
scoring ≥ `SALES_HEAD_CQS_HIGH` (default 90) or ≤ `SALES_HEAD_CQS_LOW` (default 15).
`notifySalesHead` (`lib/salesHead.ts`) fires from both scoring points — the AI
post-call path (`recordCall`) and the human callback path (`transcribeAndScoreCall`) —
independent of any handover. Anita Kishnani flagged `salesHead` in prod (rota is now
Fahar only). Schema: additive `SalesRep.salesHead`. New env: `SALES_HEAD_CQS_HIGH`,
`SALES_HEAD_CQS_LOW`. Updated [flow 5](flows/05-counsellor-and-manager-alerts.md).

## 2026-07-01 — Fix malformed TwiML on rep click-to-call (unescaped `&`)

The "who handled it" change added a `repId` query param to the recording-status
callback URL embedded in the dial TwiML, giving it a second param joined by a raw
`&`. Inside an XML attribute a bare `&` is invalid, so when the rep answered, Twilio
failed to parse the TwiML and played *"an application error has occurred"* instead of
dialing the lead. `dialLeadTwiML` now XML-escapes the callback URL (and caller id /
lead number) — `&` → `&amp;`. (The single-param URL before the repId feature had no
`&`, which is why the earlier button test passed.) File: `lib/providers/twilio.ts`.

## 2026-07-01 — Place outbound AI calls directly via ElevenLabs (drop n8n)

The outbound-call trigger routed through **n8n Agent 1** (`N8N_WEBHOOK_NEW_LEAD`), but
the n8n instance (`caraclinic.app.n8n.cloud`) went down — a `GET` on the webhook now
returns `404 No workspace here`. That silently killed every app-initiated call: the
lead saved, the phone never rang. (The same instance had already broken the *post-call*
webhook, which we bypassed earlier.) Both call sites — intake auto-call
(`lib/leadIntake.ts`) and worker retries/callbacks (`workers/callQueueWorker.ts`) —
now call `placeOutboundCall` (`lib/providers/elevenlabs.ts` →
`/v1/convai/twilio/outbound-call`) directly, removing the n8n dependency entirely. The
worker now fetches the lead's name/interest to pass as `dynamic_variables` (the old
n8n path re-fetched them server-side). Updated [flow 2](flows/02-ai-calling-and-retries.md).

## 2026-07-01 — Record who handled a human-handover call

Human-handover calls now capture the rep who took them. The initiating rep's id is
threaded through the Twilio callback URLs (clickToCall → voice TwiML →
recordingStatusCallback) and stored as `Call.handledById`. Shown as "👤 Handled by
<name>" on the lead-detail call list and a "Handled by" column on the Calls page
(AI calls show "🤖 AI"). Recording-webhook signature reconstruction switched to the
incoming path+query so the threaded `repId` is covered (verified). Schema: additive
`Call.handledById` → SalesRep.

## 2026-07-01 — Interactive Slack "Call & record" button

Handover Slack alerts now carry a "📞 Call & record" button. When a rep clicks it,
`/api/slack/interact` (Slack-signature verified) looks up the clicker's `SalesRep`
phone and fires `clickToCall` — Twilio rings the rep, then dials + records the lead.
Acks fast, reports back via `response_url`. New: `SLACK_SIGNING_SECRET`; needs
Interactivity enabled in the Slack app (Request URL `<base>/api/slack/interact`).
Files: `app/api/slack/interact/route.ts`, `lib/slack.ts` (verifySlackSignature),
`lib/handover.ts` (button). Updated flow 4.

## 2026-07-01 — Fix post-call webhook payload validation (live wiring)

The live ElevenLabs post-call webhook was returning 400 (schema reject) on real
payloads, so calls never reached `recordCall`. Two over-strict Zod constraints:

- data-collection `value` required a string, but real values can be boolean
  (`consultation_scheduled=false`) or null (`patient_name=null`);
- `dynamic_variables` required string values, but ElevenLabs injects numeric/boolean
  `system__*` variables (turns, duration, is_text_only).

Loosened both to `z.unknown()`; the mapper now coerces values via a `str()` helper.
Also repointed the workspace post-call webhook from the dead n8n URL to the CRM's
direct endpoint (`/api/webhooks/call-completed`) and set the matching signing secret.
Files: `lib/contracts.ts`, `lib/providers/elevenlabs.ts`.

## 2026-06-30 — ElevenLabs agent ↔ CRM integration contract

Aligned the AI first-call agent (the "First Call Rulebook") with the CRM. Added
[elevenlabs-agent-integration.md](elevenlabs-agent-integration.md): the exact
post-call data-collection fields the agent must emit (`outcome`, `sentiment`,
`callback_time`, `tag`, `language`, `handover_reasons`), the outcome→behaviour map,
the Rulebook §15 escalation → `handover_reasons` key mapping, the required
recording-consent disclosure, and the "WhatsApp is sent by the CRM" / "CQS is
computed by the CRM" clarifications.

Code: `HANDOVER_SUPPORTED_LANGUAGES` default changed `en,hi,mr` → `en,hi` to match
the rulebook (agent handles Hindi/English only; Marathi routes to a human).
Added gap F6 (no nurture/drip-only outcome state).

## 2026-06-30 — Gaps & roadmap backlog documented

Captured the full 2026-06-29 audit (security / reliability / compliance-ops) as
[gaps-and-roadmap.md](gaps-and-roadmap.md) — the single tracked backlog with
severity/status/file refs. Linked from the README. The three critical reliability
items are marked ✅ done (see entry below); everything else is ⬜ open.

## 2026-06-29 — Critical reliability fixes in the post-call pipeline

From the gap audit. Fixes the top reliability findings in `recordCall`:

- **Idempotency** — `Call.elevenlabsId` and `Call.providerSid` are now `@unique`;
  `recordCall` returns the existing call on a duplicate webhook (ElevenLabs/n8n/Twilio
  retries) instead of re-scoring, re-alerting, and re-scheduling. The Twilio recording
  webhook is idempotent on `CallSid` too.
- **Attempt-count bug** — the retry-ladder index now counts only AI call types, so a
  `human_handover` recording can't inflate it (which previously caused `NaN` delays or
  premature `unreachable`).
- **Atomic write** — the `Call` insert + `Lead` update run in one transaction;
  side-effects (queue/Slack/WhatsApp) are deferred until after commit.

Updated: [flow 2](flows/02-ai-calling-and-retries.md), [flow 3](flows/03-post-call-cqs-and-stage.md).
Schema change: `@unique` on `Call.elevenlabsId` + `Call.providerSid` (additive index).

## 2026-06-27 — Documentation module created

Initial flow-wise documentation covering the system as it stands in `main` after the
escalation/alerting build-out. Baseline captures these merged milestones:

- **`bdce2f0`** — System downtime / API-failure monitor → [flow 7](flows/07-system-health-monitor.md)
- **`bae6441`** — CQS transcription + hot-lead escalation + handover SLA + counsellor
  feed + daily digest → [flow 3](flows/03-post-call-cqs-and-stage.md),
  [flow 4](flows/04-handover-escalation-and-sla.md),
  [flow 5](flows/05-counsellor-and-manager-alerts.md)

Also documents the pre-existing foundation (lead intake, AI calling, WhatsApp) that
was built before the changelog began — see [flow 1](flows/01-lead-intake.md),
[flow 2](flows/02-ai-calling-and-retries.md), [flow 6](flows/06-whatsapp-messaging.md).

### Outstanding / known gaps recorded at baseline

- Live AI calling + human-call transcription gated on **ElevenLabs credits** (account at 0).
- **External uptime check** not yet set up (flow 7 limitation).
- Meta `leads_retrieval` App Review pending → FB/IG auto-call paused (flow 1).
- ElevenLabs agent not yet emitting handover reason data points (flow 4).
