# Documentation changelog

Updated with every commit merged to `main`. Each entry: date, commit, what changed,
and which flow doc(s) were updated.

Format: newest first.

---

## 2026-07-27 — Counsellor availability / presence ("Knowing who's available")

Leads no longer get assigned to counsellors who have stepped away. Each `SalesRep`
now carries live presence: `availability` (available | in_consultation | break |
offline), `availabilityAt`, `lastActivityAt` (heartbeat), `onCall`, and a free-text
`speciality`.

- **One-tap switcher** (`components/StatusSwitcher.tsx`) in the sticky header, on every
  page — never buried in settings. Shown only to logins linked to a rep. Backed by
  server actions (`app/(dashboard)/presence-actions.ts`); doubles as the heartbeat
  (pings on mount / focus / every 90s and reconciles with the server).
- **Availability-aware routing** (`lib/salesReps.ts`): `pickNextRep()` only picks
  `available` reps, so in-consultation / break / offline counsellors are skipped.
  `pickReplacementFor()` reroutes an unavailable owner's handover to an available
  colleague, **preferring the same speciality** (case-insensitive), else any available.
- **Handover** (`lib/handover.ts`): if the owner isn't available it reassigns to a
  replacement; a hot (CQS ≥ threshold) lead arriving mid-consultation also DMs the
  branch manager (urgent escalation).
- **Auto In-Consultation** (`lib/presence.ts` + click-to-call sites): a Twilio
  click-to-call marks the rep In-Consultation "without asking"; the recording webhook
  (call ended) reverts them to Active. Won't clobber a manual Break taken mid-call.
- **Auto-offline** (`sweepIdle()` on a 60s worker interval): during working hours
  (outside the DND window), a rep idle > `PRESENCE_IDLE_MINUTES` (default 15) and not
  on a call is set Offline and their manager is told on Slack.
- **Admin**: speciality is editable + live status is visible in the sales-rep roster
  (`/users`). All presence transitions are audited (`presence.change` / `presence.auto`).

New env: `PRESENCE_IDLE_MINUTES` (default 15). Schema change → run `npm run db:push`
(prod: `prisma db push`) and restart the app so the regenerated Prisma client loads.

## 2026-07-25 — Immutable audit log: record views, logins, settings + tamper-evidence

Deepens the audit trail so it can't be quietly edited. Every AuditLog row is
hash-chained (`hash = sha256(canonical(row) + previous hash)`, inserts serialised by a
Postgres advisory lock with `at` stamped inside the lock). `scripts/protectAuditLog.ts`
(`npm run protect:audit`) installs Postgres triggers that make UPDATE/DELETE/TRUNCATE on
AuditLog RAISE — the app (even a CRM admin) cannot edit or delete a log. `verifyAuditChain()`
+ a "Verify integrity" button on /audit detect any out-of-band tampering and fire a Slack
alert. Newly logged: record VIEWS (lead opens + quote-PDF opens — who/record/when/IP/device),
every login/logout/failed login, and settings changes (chatbot flows, WhatsApp templates,
branches; role-permission changes routed through writeAudit). New capability none (uses
audit.view). **Deploy: run `npm run protect:audit` against prod once.** Files: `lib/audit.ts`,
`scripts/protectAuditLog.ts`, `auth.ts`, `app/api/audit/view/route.ts`, `components/RecordViewLogger.tsx`,
`components/AuditVerifyButton.tsx`, `app/(dashboard)/audit/*`, + settings action instrumentation.

## 2026-07-25 — Compliance audit trail: field/stage/consent/reassign/export + viewer

The five things a Compliance Officer / Branch Manager reach for. Records lead field changes
(old→new; phone edits require a reason), pipeline stage moves, consent changes (opt-out),
reassignments (handover + intake assign), and data exports. New audited Leads CSV export
(`GET /api/leads/export`). Global `/audit` screen (audit.view) with filters + a per-lead
Change-history section + a small audited edit form for core fields. New capabilities
`leads.edit`, `leads.export`, `audit.view` (tunable in Hierarchy). Reuses AuditLog (no schema
change). Files: `lib/audit.ts`, `app/(dashboard)/leads/actions.ts`, `lib/salesReps.ts`,
`lib/leadIntake.ts`, `lib/callIntake.ts`, `components/{AuditTable,LeadEditForm}.tsx`,
`app/(dashboard)/audit/page.tsx`.

## 2026-07-25 — Lead handover + temporary access grants (§handover)

Counsellors/managers hand a lead to another counsellor (same-branch open; cross-branch needs
a manager + written reason); managers grant a colleague temporary access to cover a lead
without changing ownership (duration + revoke). Every change lands on the lead's Ownership &
access timeline and Slack-DMs the counsellor. New `LeadAccessGrant` model; active grants widen
the grantee's lead scope (lib/authz). New capabilities `leads.handover`, `leads.grantAccess`.
Files: `prisma/schema.prisma`, `lib/{leadOwnership,authz,audit}.ts`,
`app/(dashboard)/leads/ownershipActions.ts`, `components/LeadOwnershipPanel.tsx`.

## 2026-07-24 — Branch management + per-branch quote PDFs (§branches)

CRM Admin creates clinic branches (Santacruz, Juhu…), each carrying its legal entity + GSTIN,
address, bank + UPI/QR. A quote raised at a branch renders that branch's details on the PDF
(falls back to the original Santacruz constants for branch-less quotes). Branch grew from a
4-field stub into a real entity; new `Quote.branchId` set from the creating user's home branch
(→ default). New capability `branches.manage` (Admin default, grantable to a CEO login). QR
stored as bytes so it survives redeploys. **Deploy: `prisma db push` + `npm run seed:branch`
against prod.** Files: `prisma/schema.prisma`, `lib/branches.ts`, `lib/quotePdf.ts`,
`app/(dashboard)/branches/*`, `components/BranchesAdmin.tsx`, `scripts/seedDefaultBranch.ts`.

## 2026-07-24 — Light/dark theme toggle (no-flash, persisted)

Opt-in dark mode via a `.dark` class on `<html>`. A no-flash inline script in the root
layout applies the saved (or system) theme before paint; a ThemeToggle button (dashboard
header + login page) flips it and persists to localStorage. `globals.css` swaps the old
"never dark" neutraliser for a real `@custom-variant dark` + a warm-dark CARA palette and
button accent tweaks. `ThemeToggle` reads the live theme via `useSyncExternalStore`
(light server snapshot during hydration → no mismatch). Front-end only — no DB/schema
change. Files: `app/layout.tsx`, `app/globals.css`, `app/(dashboard)/layout.tsx`,
`app/login/page.tsx`, `components/ThemeToggle.tsx`.

## 2026-07-24 — Quote treatment catalog: dropdown auto-fills price + GST (§quote generation)

A new quote's treatment is now picked from the clinic's Master Data List instead of
typed free-text; selecting it auto-fills price, GST, and any package discount.

- **Data**: new `CatalogItem` table (type service|package, category, price, gstRate,
  defaultDiscountValue, packagePrice), seeded from `data/catalog.csv` via
  `npm run import:catalog` (upsert by type+name; `--deactivate-missing` retires dropped
  items). `scripts/importCatalog.ts` is the CSV importer. Loaded **182 services + 189
  packages** from `Master_Data_List_Ver 5.xlsx`. Campaigns + 4 items deferred
  (see the cara-catalog-deferred memory).
- **UI**: `QuotesPanel` gains a search box + grouped `<select>` (Services/Packages ×
  category). On select it fills treatment/price/gstRate/discount — packages prefill the
  STANDARD price + built-in discount % so the saving shows. Live preview + GST line
  handle 0%/exempt items. `lib/catalog.ts` `listCatalogGroups()` feeds the picker from
  the lead detail page.
- **Calc**: `createLeadQuote` now threads `gstRate` through to `createQuote`, so NA/0%
  GST treatments total correctly (discount-before-GST unchanged).
- Files: `prisma/schema.prisma`, `lib/catalog.ts`, `scripts/importCatalog.ts`,
  `data/catalog.csv`, `components/QuotesPanel.tsx`,
  `app/(dashboard)/leads/quoteActions.ts`, `app/(dashboard)/leads/[id]/page.tsx`.
- **Deploy note**: additive schema (`CatalogItem`) — `prisma db push` to prod, then run
  the catalog import against prod so the dropdown is populated.

## 2026-07-21 — Admin-editable role hierarchy / capability matrix (§3.1)

CRM Admin can now control which features each role below them can access, from a new
**Hierarchy** screen in the nav — the RBAC matrix moved from hardcoded to admin-editable.

- **Data**: new `RolePermission` table (one row per customized role, `capabilities` JSON).
  No row = the built-in defaults in `lib/rbac.ts`; `crm_admin` is always all-access and is
  never stored (can't be locked out). "Reset to default" deletes the role's row.
- **Resolver**: `lib/rbac.ts` keeps the old matrix as `ROLE_CAPABILITIES` (the default /
  fallback) and adds a `globalThis`-backed *effective* matrix that `can()` reads.
  `lib/permissions.ts` merges DB overrides over defaults and caches the result on
  `globalThis` — shared across the proxy (route-guard) and app (RSC/action) module graphs
  in one Node process — with a 15s TTL safety net. `ensurePermissions()` warms it;
  `reloadPermissions()` refreshes immediately on save.
- **Enforcement**: `ensurePermissions()` wired into `requireCapability`,
  `requireApiCapability`, the proxy route guard, and the dashboard layout, so nav items,
  in-page action buttons, and route access all reflect the live matrix. **No re-login
  needed** — the JWT carries only `role`; capabilities resolve live per request.
- **UI**: `/hierarchy` page + server actions (`saveRolePermissions` / `resetRolePermissions`,
  both audit-logged as `role.permissions.change` / `.reset`) + `HierarchyMatrix` client
  (4 editable roles × capabilities grouped by feature, per-role reset, batched save). New
  `hierarchy.manage` capability (admin-only default) gates the screen. Files:
  `prisma/schema.prisma`, `lib/rbac.ts`, `lib/permissions.ts`, `lib/authz.ts`,
  `lib/apiAuth.ts`, `auth.ts`, `app/(dashboard)/layout.tsx`,
  `app/(dashboard)/hierarchy/{page,actions}.ts(x)`, `components/HierarchyMatrix.tsx`.
- **Deploy note**: additive schema change — run `prisma db push` against prod so the
  `RolePermission` table exists (until then the app falls back to defaults and the
  Hierarchy screen errors).

## 2026-07-20 — Template builder: media headers (Image / Video / Document)

Completes the header options. Pick Image / Video / Document, attach a sample file, and
it's submitted as a media HEADER. `uploadSampleMedia()` runs Meta's 2-step resumable
upload (create session → upload bytes → `header_handle`); `createTemplate` builds a media
HEADER with `example.header_handle`. New gated proxy `POST /api/templates/upload-sample`
takes the file and returns the handle. Builder gains a file picker + media preview
placeholder. **Requires `META_APP_ID`** (Meta App Dashboard → Settings → Basic → App ID)
to be set on Railway; until then media-header uploads return a clear error. This unlocks
building the document-header template used to send the quote PDF proactively. Files:
`lib/whatsappTemplates.ts`, `app/api/templates/upload-sample/route.ts`,
`components/TemplateBuilder.tsx`.

## 2026-07-20 — Template builder: buttons + WhatsApp-style preview

The /templates builder now composes richer WhatsApp templates (closer to 11Za): add
**Quick Reply / URL / Phone** buttons (submitted as a BUTTONS component), a header-type
selector (None / Text), an "Add variable" helper, character counters, and a live
**WhatsApp-style bubble preview** of header/body/footer/buttons. Backend `createTemplate`
+ new `TemplateButton` type build/validate the buttons; template actions gated on
`templates.manage`. Media headers (image / video / document) are a follow-up — they need
a sample-media resumable upload + a Meta app id. Files: `lib/whatsappTemplates.ts`,
`components/TemplateBuilder.tsx`, `app/(dashboard)/templates/actions.ts`.

## 2026-07-18 — Quote: discount-before-GST, bank details + Razorpay QR on the PDF

- **Calculation corrected**: the discount is now applied to the base **first**, then GST
  (5%) is charged on the discounted (net) amount — `total = (base − discount) + GST`. A
  percentage discount is a % of the base. (Reverses the earlier GST-then-discount order.)
  `computeQuoteTotals` updated; UI preview + card breakdown reordered Base → Discount →
  GST → Total. Note: for a % discount the total is unchanged (commutes), but the GST
  figure and any flat-₹ discount now compute correctly.
- **Quote PDF** gains a **Payment** section: the clinic's bank details (Cara Healthcare
  Pvt Ltd, A/C 020905011291, IFSC ICIC0000209, Santacruz West) + a scan-to-pay
  **Razorpay QR** (`public/razorpay-qr.png`). Files: `lib/quoteStages.ts`,
  `lib/quotePdf.ts`, `components/QuotesPanel.tsx`.

## 2026-07-18 — Chatbot: log blocked sends for visibility

A chatbot reply that couldn't send (24h window closed) used to return early and log
nothing — the flow looked like it did nothing. `sendLeadText/Buttons/List/Image` now
log a failed outbound with the reason ("Outside the 24h window — needs a template"), so
the lead's thread shows exactly what was blocked. File: `lib/messages.ts`.

## 2026-07-18 — Chatbot: stage-change trigger (stage × campaign matrix)

Chatbot flows can now fire **proactively when a lead's pipeline stage changes**, routed
by the lead's campaign. New trigger event `stage_change` with `triggerConfig { stage,
campaign }` (configured from the flow list: a stage dropdown + optional campaign — no
schema change, the column already existed). `runStageChange(leadId, newStage)` picks the
best active flow via the matrix: a flow matching the stage AND the lead's **latest**
campaign beats a stage-only catch-all; priority then recency break ties. Skips opted-out
leads and won't interrupt an active session. Hooked into both stage-change paths — manual
`setLeadStage` and the call auto-advance in `callIntake` (post-commit, best-effort).
Business-initiated caveat: outside the 24h window the first message needs a template, so
stage flows should start with a Send Template node. Files: `lib/chatbotRuntime.ts`,
`lib/chatbotFlows.ts`, `app/(dashboard)/chatbot/{actions.ts,page.tsx}`,
`components/ChatbotList.tsx`, `app/(dashboard)/leads/actions.ts`, `lib/callIntake.ts`.

## 2026-07-18 — WhatsApp chatbot builder (list + visual builder + runtime)

New **Chatbot** nav section (`chatbot.manage` — Branch Manager / CRM Admin) to build
automated WhatsApp reply flows, modeled on 11Za. Three parts:

- **Flow list** (`/chatbot`): table of flows — name, trigger event, priority, expire-on,
  active toggle, edit/duplicate/delete + search + create. `ChatbotFlow` model.
- **Visual builder** (`/chatbot/[id]`): React Flow (`@xyflow/react`) canvas with a
  trigger start node, a grouped palette (Send a Message / Ask Questions / Utilities /
  Actions) of the core node set, a per-node config panel, branching outputs
  (Condition → Yes/No, Send Buttons → per-button, Switch, Business Hours), and Save.
  Node specs in `components/flow/nodeConfig.ts`; graph stored on `ChatbotFlow.graph`.
- **Runtime** (`lib/chatbotRuntime.ts`): on inbound WhatsApp, matches an active flow's
  trigger (inbound_message / keyword / welcome, by priority), starts a `ChatbotSession`,
  and walks the graph — sending text/media/buttons/list/template, pausing at ask/buttons/
  list nodes until the reply, storing answers, and branching. `{{name}}`/`{{var}}`
  interpolation. Hooked into `app/api/webhooks/whatsapp` (parses interactive reply ids;
  dedups on message id).

Provider: `sendWhatsAppButtons` / `sendWhatsAppList` / `sendWhatsAppImageLink` +
`sendLeadButtons/List/Image` (logged to the thread). Schema additive (`ChatbotFlow`,
`ChatbotSession`), applied to prod. v1 limits: Delay is pass-through, Jump To ends the
branch, Assign Label is a no-op, and there's no human-handoff node yet.

## 2026-07-18 — Quote PDF + send over WhatsApp

Quotes can now be turned into a **one-page PDF** and sent to the lead from inside the
lead record (§multi-quote). PDF built with pdfkit (no browser) — clinic header, quote
ref/date/validity, patient, treatment, and the Base · GST · Discount · Total breakdown;
served via a session + ownership-gated route `GET /api/quotes/[id]/pdf` (the "📄 PDF"
link). **Send on WhatsApp** on each quote card: inside the 24h window it sends a plain
document message; outside it, it uses an **approved document-header template**
(`QUOTE_DOC_TEMPLATE_NAME` / `_LANG`, `{{1}}` = patient name) so a quote can go out
proactively. Button enabled when the window is open OR a template is configured.

Files: `lib/quotePdf.ts`, `app/api/quotes/[id]/pdf/route.ts`, `lib/providers/whatsapp.ts`
(uploadWhatsAppMedia / sendWhatsAppDocument / sendWhatsAppDocumentTemplate),
`lib/messages.ts` (sendLeadDocument + template fallback), `app/(dashboard)/leads/
quoteActions.ts`, `components/QuotesPanel.tsx`, `next.config.ts` (pdfkit external).
No schema change. Email delivery is a separate follow-up (provider TBD). The proactive
template path is inert until the template is approved + env var set on Railway.

## 2026-07-17 — Quote pricing: base + GST − discount, auto-calculated total

The New Quote form now captures a **discount** (percentage OR flat rupees) and shows
a live breakdown. **GST is fixed at 5% (2.5% CGST + 2.5% SGST)** and calculated on the
**base first**; the percentage discount then applies to the GST-inclusive subtotal —
so GST is genuinely "calculated before the discount". **Total payable** is
auto-computed and stored per quote, and each card shows Base · GST · Discount · Total.

Schema additive (`gstRate` default 5, `discountType`, `discountValue`, `totalPayable`),
applied to prod. New pure calculator `computeQuoteTotals()` (client + server) in
`lib/quoteStages.ts`; `createQuote`/`reviseQuotePrice` compute + store the total (revise
keeps the quote's existing GST + discount). Files: `prisma/schema.prisma`,
`lib/{quotes,quoteStages}.ts`, `app/(dashboard)/leads/quoteActions.ts`,
`components/QuotesPanel.tsx`, `app/(dashboard)/leads/[id]/page.tsx`.

## 2026-07-17 — Quote compliance fixes (§multi-quote hard requirements)

Closes the 🔴 gaps from the quote spec:
- **Rejection reason is mandatory and from a fixed list** (`QUOTE_REJECTION_REASONS`) —
  UI dropdown + server enforcement (off-list rejected). Was a free-text prompt.
- **Withdrawal keeps a reason + the actor** — "no quote is ever deleted; withdrawn
  quotes stay with a reason and a name against them." New `Quote.withdrawnReason`
  (free-text) + `Quote.closedById` (who rejected/withdrew). Withdraw needs a reason.
- **Acceptance ≠ conversion** — picking *Accepted* advances to `awaiting_payment`
  ("Accepted — Awaiting Payment"); conversion stays the separate money step.
- **Per-quote owner** — a quote's counsellor may differ from the lead's; picker on
  each card, blocked once the quote is locked.

Schema additive (`withdrawnReason`, `closedById`), applied to prod. Files:
`prisma/schema.prisma`, `lib/quotes.ts`, `app/(dashboard)/leads/quoteActions.ts`,
`components/QuotesPanel.tsx`, `app/(dashboard)/leads/[id]/page.tsx`.

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
