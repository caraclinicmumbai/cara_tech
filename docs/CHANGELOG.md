# Documentation changelog

Updated with every commit merged to `main`. Each entry: date, commit, what changed,
and which flow doc(s) were updated.

Format: newest first.

---

## 2026-08-30 — The full report set: ten management read-outs at `/reports`

Flow doc added: **[flows/12-reports.md](flows/12-reports.md)**.
Files: `lib/reports/{range,shared,funnel,people,attribution,lost,money}.ts`,
`lib/adSpend.ts`, `app/(dashboard)/reports/**`, `components/ReportUI.tsx`,
`components/ReportRangePicker.tsx`, `app/api/webhooks/ad-spend/route.ts`,
`scripts/importAdSpend.ts` (all new), `lib/rbac.ts`, `app/(dashboard)/layout.tsx`.
Schema: new `AdSpend` model (migration `..._ad_spend`).

Ten reports over one shared date range, building on the Month-4 dashboard:

1. **Lead Inflow** — volume, source, campaign, branch, day by day, vs the previous period.
2. **AI Contact Rate** — attempts vs contacts, at call level and person level, attempts
   needed before contact, first attempt vs reconfirmation.
3. **Handoff Speed** — time from handover to the first *logged* human action, median /
   mean / SLA share, per counsellor, plus the ones still waiting.
4. **Counsellor Performance** — leads, consultations, quotes, conversions, pickup speed.
5. **Source Attribution** — cost per lead, per consultation, per surgery, and ROAS.
6. **Lost Lead Analysis** — by tag, by source, survival time, and the written reasons.
7. 💰 **Treatment Mix** — quoted vs converted, average value, best and worst converting.
8. 💰 **Lost Quote Analysis** — rejected / withdrawn / **lapsed**, by reason and treatment,
   with the pricing signal called out explicitly.
9. 💰 **Multi-Quote** — how often a patient buys two treatments, which pairs go together,
   and what the second one is worth.
10. 💰 **Repeat Treatment** — who comes back, after how long, for what.

**The rules the numbers obey** (`lib/reports/shared.ts`, shared so tabs can't disagree):

- **Null is never zero.** A rate with no denominator renders as "—", not "0%".
- **Reached** = a person answered and a decision was recorded, so "not interested" counts.
- **Picked up** = a logged call or a counsellor-typed message; dialling from a personal
  handset leaves no trace and reads as not picked up.
- **Consulted** = the stage says so *or the patient bought* — otherwise a patient who
  converted without their stage being moved produced rates above 100%.
- **A quote is worth its invoice** where one exists, its quoted total where it doesn't.
- **Lapsed quotes are counted.** Nothing marks quotes expired, so the quiet losses —
  usually the biggest group — appeared in no loss count at all before this.
- **Unowned quotes are stated, not dropped**, under the counsellor table.

**Ad spend, and why a missing day is not zero.** New `AdSpend` table (one row per IST day
/ source / campaign), filled by `scripts/importAdSpend.ts` (CSV, forgiving headers, ₹ and
thousands separators, `--zero-fill`) or `POST /api/webhooks/ad-spend` (shared secret,
batched). **A day nobody imported is "unavailable" and every cost figure covering it is
withheld** — counting it as ₹0 would understate cost and make the forgotten channel look
like the cheapest one. A day with genuinely no spend must be imported as an explicit 0.

**Access.** Two new capabilities: `reports.view` (the page and reports 1–6) for Telecalling
Head, Branch Manager, Sales Head; `reports.revenue` (the four 💰 reports plus money columns
in 4 and 5) for Branch Manager and Sales Head. Both editable on `/hierarchy`.

Ranges are IST calendar days throughout (`lib/reports/range.ts`), held in the URL so they
survive tab switches and can be shared.

---

## 2026-08-30 — Billing: an invoice is what converts a quote, and it sets the branch credit

Flow doc updated: **[flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md)** (new
"Invoiced = converted" + "The credit, and the 7-day dispute" sections).
Files: `lib/invoices.ts`, `lib/branchCredit.ts`, `app/api/webhooks/invoice/route.ts`
(all new), `lib/quotes.ts`, `lib/rbac.ts`, `app/(dashboard)/leads/quoteActions.ts`,
`components/QuotesPanel.tsx`, `app/(dashboard)/leads/[id]/page.tsx`. Schema: new
`Invoice` and `QuoteCreditDispute` models (migrations `..._invoices`,
`..._quote_credit_disputes`).

Two of the four items in the spec's calendar/billing section that weren't built.

**"Converted" now means an invoice exists for that specific quote.**

- `POST /api/webhooks/invoice` (shared secret) records what billing raised, sets the
  quote's invoiced branch from it, converts the quote — which locks it and opens the
  post-sales journey exactly as before. Idempotent on the invoice number; the same
  number pointed at a second quote is refused rather than silently moved.
- **Invoices attach to the QUOTE, never the lead** — a transplant invoiced at one branch
  and a PRP course at another each keep their own credit.
- **Marking a quote converted by hand is refused.** The escape hatch is admin-only and
  still writes a real invoice, with a mandatory reason, flagged "recorded by hand".
- **No card or bank details** — a number, an amount, a branch, a date.

**The credit follows the invoice, with one release valve.**

- A branch manager disputes for **their own** home branch (never a dropdown), with a
  reason, inside **7 days** of the credit landing. One dispute per quote, enforced by a
  unique key; the deadline is stored, not recomputed.
- The **Sales Head decides once**, with a mandatory note. Upholding moves the credit —
  the only path by which a credit ever moves. A decided dispute can't be reopened.
- New capabilities `quotes.disputeRaise` (branch manager, sales head) and
  `quotes.disputeDecide` (sales head).

**Production:** point the billing system at `/api/webhooks/invoice` with `WEBHOOK_SECRET`.
Until then, conversions there need the admin override — intended, but tell the team.

## 2026-08-30 — WhatsApp: file-header templates, and finding the quote's document template

Flow docs updated: **[flows/06-whatsapp-messaging.md](flows/06-whatsapp-messaging.md)**,
**[flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md)**.
Files: `lib/whatsappTemplates.ts`, `lib/providers/whatsapp.ts`,
`components/WhatsAppChat.tsx`, `components/QuotesPanel.tsx`,
`app/(dashboard)/leads/quoteActions.ts`, `app/(dashboard)/leads/[id]/page.tsx`.
No schema change.

- **The chat picker no longer offers a template it can't send.** Choosing
  `quote_document` from the composer failed with *"(#132012) … expected DOCUMENT,
  received UNKNOWN"*: the template carries a document header and the composer has no
  file to attach. Templates with a file header are filtered out and named, with where
  they do go out from ("…it attaches a file, so it goes out from the lead's Quotes panel
  instead").
- **Send errors are translated, not dumped.** Meta's raw JSON was landing in front of
  counsellors; `humanGraphError` turns the common codes into a sentence and keeps the
  payload in the log.
- **"Send on WhatsApp" worked locally and was dead in production** because
  `QUOTE_DOC_TEMPLATE_NAME` was in `.env.local` and never in Railway. The template is now
  resolved from the WABA — an approved DOCUMENT-header template *is* what this send needs
  — with the env var demoted to an override for when several exist. The disabled label
  also stops saying "(window closed)" when the real problem is a missing template.

## 2026-08-29 — Date filters on the leads table (follow-up, created, updated)

Flow doc updated: **[flows/01-lead-intake.md](flows/01-lead-intake.md)**.
Files: `components/LeadsTable.tsx`, `app/(dashboard)/leads/page.tsx`, `lib/datetime.ts`
(`istDateKey`). No schema change.

Three columns gained a calendar filter — a native date picker, so it's keyboard- and
mobile-friendly — with per-column shortcuts:

| Column | Shortcuts |
|---|---|
| Next follow-up | Today · Tomorrow · **Overdue** |
| Created / Updated | Today · Yesterday |

History can't be overdue, hence the split. The shortcut set and the overdue predicate
come from the column definition, so a fourth date column is a two-line change. It joins
the existing per-column filters, composes with owner/stage/source, and clears with
"Clear all filters".

**Comparison is on the IST calendar day** (`istDateKey`), never a formatted label or a
UTC date — anything dated after 6:30pm IST would otherwise land on the wrong day. The
same trap bites from SQL: these are naive `timestamp` columns holding UTC, so the correct
conversion is `("col" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata'`; the single-cast
form shifts everything by 5:30 (it made a verification query disagree with the app, and
the app was right).

## 2026-08-29 — Converted quotes on the Open Quotes desk

Flow doc updated: **[flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md)**.
Files: `lib/openQuotes.ts` (`getConvertedQuotes`), `app/(dashboard)/quotes/page.tsx`.
No schema change.

The desk showed only what was still in play, so won work — the number the clinic is
measured on — was visible nowhere except one lead at a time. A second table now sits
below the pipeline: patient, treatment, status, value, converted date, days to close,
counsellor, and the billing branch when it differs from where the quote was raised.
Three roll-ups beside the heading: how many converted, what that's worth, and the last
30 days.

Deliberately leaner than the pipeline table — staleness, expiry and the activity trail
are chase machinery and a settled quote isn't being chased. It follows the page's
ownership scope and branch filter but not the pipeline pills. Capped at 50 rows while
the value totals still count everything in scope, so a truncated list can't understate
what was won.

## 2026-08-29 — Click-to-call rings whoever pressed the button

Flow doc updated: **[flows/04-handover-escalation-and-sla.md](flows/04-handover-escalation-and-sla.md)**.
Files: `app/(dashboard)/leads/actions.ts`, `components/CallButton.tsx`. No schema change.

The button dialled the lead's assigned rep, falling back to the least-recently-assigned
counsellor on the rota. A telecaller covering someone else's lead, or a manager stepping
in, pressed Call and rang a **colleague's** handset — and the recording, the `Call` row
and the In-Consultation status were filed against that colleague, who was never on the
call.

It now rings the caller's own number (`User.salesRepId` → that rep's phone), and
attribution follows. A login with no linked counsellor profile is refused with a message
naming the fix rather than falling back to someone else's phone — note that this means
**an unlinked login (including `admin@`) can no longer place calls at all**.

## 2026-08-29 — Follow-up: the roadmap panel goes, the dates stay

Flow doc updated: **[flows/01-lead-intake.md](flows/01-lead-intake.md)** (new "Follow-up
dates" section). Files: `components/FollowUpRoadmap.tsx` + `app/(dashboard)/leads/followUpActions.ts`
(deleted), `app/(dashboard)/leads/[id]/page.tsx`, `lib/followups.ts`, `lib/leadIntake.ts`,
`scripts/backfillFollowUpDates.ts` (new). No schema change.

- **The panel is gone.** It was a checklist to maintain — add, complete, skip, reassign —
  when what the desk uses is "when is this lead next due". The lead page now shows the
  next pending step as a `Follow Up` field (date · title, red "(overdue)" past due, with
  the patient's own requested callback time beneath it). Reverting one commit brings the
  panel back.
- **The scheduling underneath is untouched** — steps are still seeded and still moved by
  call outcomes and stage changes, because they're what generate the dates.
- **Every lead now gets a ladder.** 19 of 20 active leads had no steps at all: leads
  predating the feature, plus duplicates / held-for-review / walk-ins, which intake
  skipped on the assumption staff would add steps by hand in the panel that no longer
  exists. Those now get the same ladder minus the AI steps, re-based so the first human
  touch is the day after intake. `scripts/backfillFollowUpDates.ts` fixes existing leads
  (anchored at 10:00 IST, not back-dated; converted and lost leads left alone).
- The column renders a **date** rather than a timestamp — the hour is an artefact of when
  the lead arrived.

**Production still needs the backfill run** — the code change only helps leads created
from now on.

## 2026-08-27 — WhatsApp inbox: a tab for patient conversations

Flow doc updated: **[flows/06-whatsapp-messaging.md](flows/06-whatsapp-messaging.md)**
(new "The WhatsApp tab (inbox)" section).
Files: `app/(dashboard)/whatsapp/page.tsx` + `actions.ts` (new),
`components/WhatsAppInbox.tsx` (new), `lib/whatsappInbox.ts` (new),
`app/api/whatsapp/conversations/route.ts` (new), `components/WhatsAppChat.tsx`
(`variant="fill"`), `app/(dashboard)/layout.tsx` (tab + badge), `lib/rbac.ts` (route
gate). Schema: new `ChatRead` model (migration `20260826212508_chat_read`).

Inbound replies had nowhere to land: they were visible only on the lead they belonged
to, so noticing one meant opening leads and looking.

- **`/whatsapp` is an inbox**, laid out like WhatsApp Web — chats down the left (newest
  first, with a preview, WhatsApp-style timestamp, unread count, 24h-window state and
  the owning counsellor), the selected thread on the right. Search covers name, number
  and message text.
- **The thread pane is the same `WhatsAppChat`** the lead page uses, in a new fill
  variant — so the live SSE stream, window rules, template picker and delivery ticks are
  one implementation, not two.
- **Unread is per USER** (`ChatRead`, one row per user × lead), because the clinic
  shares one number and one counsellor opening a chat must not clear a colleague's
  badge. Opening a conversation catches it up; a reply into an open chat re-marks it.
- **The list polls every 15s** (paused while hidden, refreshed on focus) while the open
  thread streams. The sidebar tab carries the unread total, server-rendered.
- Gated on the existing `leads.whatsapp` capability, and scoped like every lead view —
  a telecaller sees their own conversations, a manager sees all; the `?lead=` id is
  re-checked server-side.

## 2026-08-24 — Preflight check for demos and shift starts

Files: `scripts/preflight.ts` (new). No schema change.

One read-only command that answers "is everything up and in credit": database, Redis,
both web URLs, ElevenLabs quota, the ConvAI agent, Twilio balance, the WhatsApp number
and template statuses, Anthropic, Slack — plus the data-side things that make a demo
look broken while every API is green (ownerless leads, reps with no login, numbers that
aren't E.164). It queries account/status endpoints only: never sends, calls or spends.

First run caught **ElevenLabs at 165,372 / 165,406 characters with overflow billing
disabled** — AI voice calls were dead until the quota reset, which no screen in the app
would have told anyone.

## 2026-08-23 — Quote PDF masthead is the clinic, not the branch

Files: `lib/quotePdf.ts`. No schema change.

A quotation raised at Santacruz was headed **"Cara Santacruz"** — the branch's display
name, which reads to a patient like a different business from the clinic they enquired
at. The masthead is now `CLINIC_NAME` ("Cara Clinic"), and the branch keeps its place on
the line it belongs on, next to the address it identifies: *"Cara Santacruz — Linking
Road, Santacruz West, Mumbai"*. Everything else the branch supplies — address, GSTIN,
bank details, UPI QR — is unchanged, so the document still says where the money goes.

Noted while checking: the Santacruz branch has **no GSTIN** on file, so quotes from it
print none. Its registered entity ("Cara Healthcare Private Limited") appears only in
the bank block, not next to the GSTIN.

## 2026-08-23 — Click-to-call no longer dies silently on an undialable number

Flow doc updated: **[flows/04-handover-escalation-and-sla.md](flows/04-handover-escalation-and-sla.md)**.
Files: `lib/phone.ts` (new), `lib/providers/twilio.ts`,
`app/api/twilio/dial-result/route.ts` (new), `app/(dashboard)/leads/actions.ts`,
`lib/leadIntake.ts`, `lib/inboundRouting.ts` (`dialablePhone` moved to `lib/phone`),
`lib/notifications.ts` (`call_failed` kind), `scripts/normalizePhones.ts` (new).
No schema change.

**Reported from testing:** a call announced "this call is recorded", then hung up.
Twilio's own log says why — the rep leg completed after 4s (just the announcement) and
the patient leg failed instantly with **error 13225**, because the lead's number was
stored as `+18850925804`: a 10-digit Indian mobile carrying a `+1`. E.164-shaped, so
nothing rejected it, but `885` routes nowhere.

- **Numbers are normalised now, not passed through as typed.** `lib/phone.ts` reads a
  bare 10-digit as `+91` (India-only clinic), strips formatting, and refuses what can't
  be dialled — including a NANP number whose area code or exchange is impossible.
  Applied at intake, on lead edit (which refuses outright, since a human is looking at
  the file), and before every click-to-call, which now names the offending number
  on screen instead of starting a call that dies.
- **A call that never connects is now recorded.** The recording callback only fires for
  a call that happened, so a failed one left the rep in silence and the CRM with no
  trace. A `<Dial action>` callback (`/api/twilio/dial-result`) fires on any outcome:
  files a `Call` with the outcome, rings the rep's bell, reverts their In-Consultation
  status, and speaks the reason ("That number could not be reached…").
- `scripts/normalizePhones.ts` repairs stored rows — unambiguous rewrites only,
  anything else reported for a human. Run on local data: 9 leads + 1 rep normalised,
  0 needing a decision.

**These callbacks only work where Twilio can reach the app.** With
`NEXTAUTH_URL=http://localhost:3000` nothing Twilio sends arrives; local call testing
needs a tunnel with `TWILIO_PUBLIC_BASE` set, or use the deployed environment.

## 2026-08-23 — Merging a duplicate keeps the original's counsellor

Flow doc updated: **[flows/01-lead-intake.md](flows/01-lead-intake.md)**.
Files: `app/(dashboard)/leads/actions.ts` (`mergeDuplicateLead`),
`components/MergeLeadButton.tsx`, `app/(dashboard)/leads/[id]/page.tsx`. No schema change.

A re-enquiry from a known patient is round-robined to whoever is next on the rota, so a
merge could quietly hand the relationship to a second person mid-conversation.

- **The merged record keeps the ORIGINAL's owner** — the counsellor already working that
  patient. It was landing there by accident of the merge direction (the original
  survives); it's now an explicit rule.
- **Falls back to the duplicate's owner** only when the original has no counsellor at
  all, so a merge can't produce an ownerless lead. The audit entry records `ownerRepId`
  and `ownerFilledFromDuplicate`.
- **The UI says so before you commit to it**: the duplicate banner names the original's
  counsellor, the merge control reads "Stays with Rohit — leaves Hero", and the confirm
  dialog repeats it. Merging takes the lead off the duplicate owner's list; nobody should
  discover that afterwards.

Not done: the duplicate's owner isn't notified when someone else merges their lead away.

## 2026-08-23 — A handover no longer 404s the person who performed it

Flow doc updated: **[flows/04-handover-escalation-and-sla.md](flows/04-handover-escalation-and-sla.md)**
(new "Staff-to-staff handover" section — that path wasn't documented anywhere).
Files: `lib/leadOwnership.ts` (`recentHandoverForViewer`, `notifyRep`/`notifyUser` on
handover + grant), `app/(dashboard)/leads/[id]/page.tsx`,
`app/(dashboard)/leads/ownershipActions.ts`, `components/LeadOwnershipPanel.tsx`,
`lib/notifications.ts` (`access_grant` kind). No schema change.

Two gaps in the ownership panel, both reported from testing:

- **The bell only covered the AI path.** Handing a lead to a colleague from the lead
  page, and granting temporary access, went to Slack only — the receiving telecaller got
  nothing in the software. `handoverLead` now notifies the receiving rep (naming who
  handed it over and why) and `grantLeadAccess` notifies the grantee. A manager handing a
  lead to their own rep identity is skipped.
- **The giver got a 404.** Handing your own lead away costs you access to it, so the page
  you were standing on answered "This page could not be found" the instant the transfer
  landed. The lead page now shows **"{lead} is now with {rep}"** with the date, reason and
  a way back — to exactly two people: the previous owner (matched on `meta.fromRepId`,
  newly recorded on the handover audit entry) and whoever performed the transfer
  (`actorId`). Everyone else still gets the plain not-found, so the record's existence
  isn't leaked. It survives a reload and the back button because it's rendered from the
  audit trail, not from client state.

## 2026-08-23 — A handover reaches its telecaller in the software (header bell)

Flow doc updated: **[flows/04-handover-escalation-and-sla.md](flows/04-handover-escalation-and-sla.md)**.
Files: `lib/notifications.ts` (new), `components/NotificationBell.tsx` (new),
`app/api/notifications/route.ts` (new), `app/(dashboard)/notificationActions.ts` (new),
`app/(dashboard)/layout.tsx`, `lib/handover.ts`. Schema: new `Notification` model
(migration `20260822185231_notifications`).

A handover only ever reached a counsellor on **Slack**. Now it reaches them where they
work: a bell in the dashboard header with an unread count.

- **Durable, not a toast.** One `Notification` row per recipient login, so a telecaller
  who was away still sees the handover when they next sign in. Clicking an entry opens
  the lead and marks it read; there's a "Mark all read".
- **Deduped** on a unique `dedupeKey` (lead + trigger set), so a re-scored call or a
  retried webhook doesn't stack identical bells.
- Raised for the **owner**, plus a separate "please cover" bell for a colleague covering
  an away owner, and on a hot-call escalation.
- **Slack is now an addition, not the channel.** The DM still fires when
  `SLACK_BOT_TOKEN` is set; unset it for in-app-only notification.
- The bell polls its feed every 45s, pauses while the tab is hidden, catches up on focus.
- Needs the counsellor to have a **login linked to their `SalesRep`** (`User.salesRepId`).
  A rep with no login can only be reached on Slack — local dev now links
  `telecaller@caraclinic.com` to a "Test Telecaller" rep.

The lead's visibility in the owner's Leads section and its purple `handover` tag already
worked (owner scoping + `LeadsTable`); both were verified rather than rebuilt.

## 2026-08-23 — Every lead gets a telecaller at intake; handover keeps that owner

Flow docs updated: **[flows/01-lead-intake.md](flows/01-lead-intake.md)** (new
"Ownership at intake" section), **[flows/04-handover-escalation-and-sla.md](flows/04-handover-escalation-and-sla.md)**.
Files: `lib/salesReps.ts` (`pickOwnerRep`), `lib/leadIntake.ts`, `lib/messages.ts`,
`lib/handover.ts`, `lib/leadOwnership.ts` (`grantCoverAccess`),
`scripts/backfillLeadOwners.ts` (new). No schema change.

Assignment-at-intake existed but wasn't firing: `pickNextRep()` only considered reps
whose presence is `available`, so a team on break/offline left the lead with **no owner**
and nothing ever fixed it (18 of 19 local leads were ownerless). A cold WhatsApp enquiry
skipped assignment entirely.

- **`pickOwnerRep()`** prefers an available counsellor but falls back to any active one.
  Ownership answers "whose lead is this to follow up", not "who is at their desk";
  only an empty roster leaves a lead unowned, and that logs a warning.
- **Cold WhatsApp leads** (`findOrCreateLeadByPhone`) are assigned like every other source.
- **A handover no longer re-assigns an away owner's lead.** The owner keeps it; an
  available colleague gets the ping plus a **2-day temporary access grant**
  (`grantCoverAccess` — audited as a system grant, idempotent), and the alert names both.
- `scripts/backfillLeadOwners.ts` assigns leads that predate this, spreading them across
  the whole active roster (presence is meaningless for historical leads).

## 2026-08-23 — WhatsApp chat: real message text, auto-filled variables, live thread

Flow doc updated: **[flows/06-whatsapp-messaging.md](flows/06-whatsapp-messaging.md)**.
Files: `lib/messages.ts`, `lib/whatsappTemplates.ts`, `lib/templateFill.ts` (new),
`lib/realtime.ts` (new), `app/api/leads/[id]/messages/stream/route.ts` (new),
`components/WhatsAppChat.tsx`, `app/(dashboard)/leads/[id]/page.tsx`,
`scripts/backfillTemplateBodies.ts` (new). Schema: `Message.updatedAt` (migrations
`20260822113308_message_updated_at` + `..._backfill`).

Three things testing caught in the chat panel:

- **The thread showed the template's name, not the message.** A template send was logged
  as `[template] <name>`; it now stores the approved BODY with its `{{n}}` values filled
  in, with `templateName` kept as a chip on the bubble.
  `scripts/backfillTemplateBodies.ts` repairs historical rows (their parameter values
  were never recorded, so those keep visible `{{1}}` placeholders).
- **The picker asked for variables already on the record.** `lib/templateFill.ts` guesses
  each slot from the words before it (patient name / treatment / clinic / rep), pre-fills
  it, labels where the value came from, and previews the exact outgoing message. A blank
  slot blocks the send — Meta rejects an empty parameter.
- **The chat wasn't live.** Every thread write publishes the lead id on a Redis channel;
  `GET /api/leads/[id]/messages/stream` is an SSE endpoint that pushes the delta to open
  chat windows. Redis is a nudge, not the transport — the stream also polls slowly, so an
  outage costs latency, not chat. The cursor is `Message.updatedAt`, so delivery ticks
  (sent → delivered → read) stream too, and an inbound reply re-opens the composer live.

Also: `buildTemplateComponents` no longer drops blank params — that shifted later values
into earlier slots and could send a scrambled message.

**Migration note.** The first `updatedAt` migration seeded existing rows from
`CURRENT_TIMESTAMP`, which Postgres evaluates on the DB's local clock while Prisma writes
UTC — on an IST server every old row landed 5h30m in the future and jammed the stream
cursor. The follow-up migration re-seeds `updatedAt` from `createdAt`; both must deploy
together.

## 2026-08-23 — Quote sharing outside the 24h window (config)

Flow doc updated: **[flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md)** (env
table already documented it); `docs/deferred-todo.md` item closed. Files: `.env.example`.
No code change.

The quote PDF send path already fell back to an approved **document-header template**
when the 24h window is closed, but `QUOTE_DOC_TEMPLATE_NAME` was never set, so "Send on
WhatsApp" read "(window closed)" and was disabled. The WABA already carries an APPROVED
`quote_document` (en) with a DOCUMENT header and `{{1}}` = patient name, so local dev now
sets it. **Production still needs `QUOTE_DOC_TEMPLATE_NAME` / `QUOTE_DOC_TEMPLATE_LANG`
in the Railway environment** or proactive quote sharing stays disabled there.

## 2026-08-22 — Inbound call routing for the published clinic number

New flow doc: **[flows/11-inbound-call-routing.md](flows/11-inbound-call-routing.md)**.
Files: `lib/inboundRouting.ts` (policy), `app/api/twilio/inbound/*` (Twilio adapter,
whisper, voicemail), `lib/providers/twilio.ts` (TwiML builders), `lib/leadIntake.ts`
(new `inbound_call` source), `lib/counsellor.ts` (`missed_inbound` alert). No schema
change; `Call.callType` gains `inbound` / `inbound_voicemail` by convention.

A patient ringing the number on the website now reaches **the counsellor they already
spoke to**, and only falls elsewhere when that person genuinely can't take it:

```
owner (sticky) → same-speciality colleague → round-robin → ~25s hold → voicemail
```

- **Sticky is lead ownership** — the caller returns to `Lead.assignedRepId` for as long
  as they own the lead. Unknown numbers become leads (source `inbound_call`, which
  never triggers an AI cold-call) and are assigned once, so the second call is sticky.
- **Reachable** = active, `available`, not already `onCall`, and holding a dialable
  number. Answering flips the rep to In-Consultation via the whisper callback, so the
  next call doesn't ring a handset already in use.
- **The hold drops `tried` deliberately** — a counsellor who hangs up during the hold
  takes the call rather than it going to voicemail because everyone was momentarily busy.
- **Voicemail is accountable**: stored as a Call, transcribed, a "Return missed call"
  step added to the owner's roadmap due now, and a Slack alert. Idempotent on CallSid
  (Twilio fires the callback twice).
- Every route verifies `X-Twilio-Signature`. The `tried` list uses repeated params of
  bare cuids because Next re-encodes `,` → `%2C` in `req.url`, which would fail the
  signature comparison and silently 403 the whole ladder.

**Not live yet.** Production has no Twilio configuration and the website number is not
pointed at the webhook; a Twilio +91 number also needs India regulatory approval before
it can receive calls. Verified against signed simulated Twilio requests end to end.

## 2026-08-21 — Sales-rep speciality is a fixed list, not free text

Files: `lib/specialities.ts` (new), `components/UsersAdmin.tsx`,
`app/(dashboard)/users/actions.ts`. No schema change — `SalesRep.speciality` stays a
nullable string; the constraint is enforced in the app.

The speciality box on the sales-rep roster (`/users`) was free text, so "Hair",
"hair transplant" and a typo were all storable — and `pickReplacementFor()`
(`lib/salesReps.ts`) matches on equality, so a mismatched string silently means an
offline counsellor's leads never find the same-skill colleague they were meant to.

- **Both controls are now dropdowns**: the Add-rep form and the per-row editor, offering
  **Hair / Skin / Face** plus a blank "Generalist".
- **Validated server-side too** in `createRep()` and `setRepSpeciality()` — the actions
  are reachable by direct POST, so the dropdown alone isn't a constraint.
- **Pre-existing values are preserved, not silently rewritten.** A rep saved before the
  list existed (local dev has one holding `"hair transplant"`) keeps that value as a
  selectable option labelled `(unrecognised)`, so the row shows what is actually stored
  instead of reading as Generalist. Picking a real speciality replaces it; nothing
  rewrites it in the background.

## 2026-08-19 — Internal patient history summary PDF (converted quotes)

Files: `lib/patientHistory.ts` (read model), `lib/historyPdf.ts` (renderer),
`app/api/quotes/[id]/history/route.ts`, `components/QuotesPanel.tsx`,
`app/(dashboard)/leads/[id]/page.tsx`. Flow doc: **[flows/10-quote-lifecycle.md](flows/10-quote-lifecycle.md)
§7**. No schema change.

A converted quote now offers `🗂 History PDF` on its card — the whole file on that
patient, for internal use: ownership (the telecaller who sold it, and the lead owner),
the quotation with its full price trail, the clinical context on record, every call with
outcome/sentiment/CQS/objection and its AI summary, one chronological log of **every**
contact (calls, WhatsApp both ways, staff notes, completed follow-up steps, care
check-ins, the quote and the conversion), and the verbatim transcripts appended.

- **Gated harder than the quote PDF**: `quotes.view` **and** `calls.view`, plus lead
  ownership. The clinical roles hold neither capability, so this cannot become a back
  door into the recordings the post-sales team is deliberately denied (§post-sales,
  flow 9). This module is the inverse of `lib/postSales/handover.ts` and must never be
  wired into the ERP UI.
- Every download writes a `record.view` audit row naming the actor and the volume
  pulled (calls, messages, transcripts). Stamped `INTERNAL` on every page.
- Only converted quotes qualify — an open quote returns 409, since a history file of a
  live negotiation reads as a closed one.
- Rendered on demand, nothing stored; transcripts capped at 6,000 chars each with the
  truncation stated in the document.

**No medical history is included, because the CRM holds none.** There is no field for
conditions, allergies, medications or an intake questionnaire anywhere in the schema.
The PDF states that outright and prints the clinically-relevant data that does exist
(stated interest, what they asked for, language, clinical consent, safety flags,
post-sales clinical notes) rather than leaving a blank section that would read as a
clean bill of health.

## 2026-08-19 — Open Quotes desk (`/quotes`)

New nav section, gated on `quotes.view` (route guard: `routeCapability("/quotes")`).
Files: `lib/openQuotes.ts` (read model), `app/(dashboard)/quotes/page.tsx`,
`app/(dashboard)/layout.tsx`, `lib/rbac.ts`. No schema change.

Every quote still in play — `drafted` / `sent` / `viewed` / `accepted` /
`awaiting_payment` — on one screen, so a manager can see the money in the pipeline
without opening leads one at a time.

- **Five roll-up tiles**: open count, pipeline value (total payable), *gone quiet*
  (no activity in `STALE_AFTER_DAYS` = 7d), *lapsing* (expired or inside
  `EXPIRING_WITHIN_DAYS` = 7d), and *unassigned* (no counsellor on the quote).
- **Money broken out per row** the way the quote itself computes it: base →
  discount (as entered — `12.5%` or flat ₹ — plus the rupees it took off) → GST at
  the quote's own stored rate → payable. Shared with the quote PDF via
  `computeQuoteTotals()`, so the desk can't drift from the document.
- **What has been DONE on the quote.** Quote actions are audited against the *lead*
  with `meta.quoteId` (`leads/quoteActions.ts`), so the read model fetches the trail
  by lead and regroups it by quote. Each row shows its last action and expands
  (native `<details>`, no client JS) into the full trail — raised / price revised /
  status moved / reassigned, each with actor, timestamp, and the `from → to`.
  Revision count excludes the opening version a priced quote is created with.
- **Filters are links**, not client state: status (with per-status count and value),
  owner, branch, and the three problem pills. Owner and the pills filter in memory so
  the tiles and the owner list keep showing the whole scope — the header reads
  "Showing 3 of 27 · ₹x of ₹y".
- **Scoped by lead visibility** (`leadWhereForUser`): a counsellor sees quotes on
  their own leads; a manager sees the branch. Read-only by design — a quote is still
  edited on its lead, where the rest of the person's context is.

Known gap: the quote lifecycle (§multi-quote) still has no `flows/*.md` of its own.

## 2026-08-19 — Leads table: six new columns (owner, follow-up, deal, last call, remark, updated)

Migration `20260819135141_lead_remark`. Files: `app/(dashboard)/leads/page.tsx`,
`components/LeadsTable.tsx`, `components/RemarkField.tsx`,
`app/(dashboard)/leads/actions.ts`.

The `/leads` table now carries the six fields a counsellor was previously opening each
lead to read:

- **Owner** — `Lead.assignedRep.name`, enum-filterable (blank shows as "Unassigned").
- **Next follow-up** — the earliest *pending* `LeadFollowUpStep` with a due date, rendered
  in IST with the step title as its tooltip; an overdue one (same `visualStatus()` rule as
  the roadmap) renders red.
- **Deal amount** — the total of the lead's **won** quotes (`converted` / `in_treatment` /
  `completed`, `totalPayable` falling back to `price`). Before anything converts, the
  latest still-open quote stands in, greyed, tooltipped "not converted yet".
- **Calls / Last call** — the newest `Call.createdAt`. The page now loads each lead's calls
  once (newest-first) and derives both the last-call date and the latest *scored* call's
  CQS from that one list.
- **Remark** — new `Lead.remark` column: a single mutable one-line staff note, edited
  inline in the table like the tag (500 chars, audited old → new via
  `setLeadRemark`, gated on `leads.comment`; read-only text without it). Deliberately
  distinct from `LeadComment`, which stays the append-only authored thread.
- **Updated** — `Lead.updatedAt` in IST.

## 2026-08-18 — Post-sales ERP: one journey per converted quote (§post-sales)

New flow doc: **[flows/09-post-sales-journey.md](flows/09-post-sales-journey.md)**.
Migration `20260818084432_post_sales_erp`.

The clinical side of the clinic — doctors, OT team, post-sales consultants, front desk —
now has its own pipeline, attached to the **converted quote** rather than the lead. A
patient who converts a hair transplant and a PRP course gets two journeys running at their
own speeds.

- **Three new RBAC roles** — `doctor`, `ot_team`, `post_sales_consultant` — and four
  capabilities (`postsales.view` / `.manage` / `.checkins` / `.policy`). The spec's "the
  post-sales team owns these stages, sales counsellors can't edit them" is expressed as the
  capability split: counsellors get `view`, not `manage`.
- **The clinical roles hold neither `leads.view` nor `calls.view`**, and `/leads` + `/calls`
  are now capability-gated in `routeCapability()` (previously open to any signed-in user).
  So "the post-sales team sees the summary — not the full call recordings" is access
  control, not a hidden button. `leadScope()` also lists them as `own`-scoped as defence in
  depth. New always-reachable `/no-access` page + `landingPath(role)` so gating `/leads`
  can't bounce a doctor in a redirect loop.
- **`PostSalesJourney`** (one per quote, `quoteId @unique`) — six stages
  `converted → pre_op → surgery_done → post_op_followup → recovery_monitoring →
  closed_successfully`. Opens automatically on conversion; forward moves are one click, a
  **backward move needs a written reason**; entering `surgery_done` requires the surgery
  date, which anchors the check-in schedule.
- **Per-treatment stage time limits** (`TreatmentStagePolicy`, editable at
  `/post-sales/policies`, built-in defaults live from day one): hair-transplant recovery
  120d vs PRP 45d. Overdue → a `postsales.stage.overdue` audit row + a Slack alert to the
  accountable consultant/doctor, deduped per stall via `overdueNotifiedAt`.
- **`reconcileMissingJourneys()`** in the same worker pass opens a journey for any converted
  quote that lacks one — closing the gap the spec calls "the single most likely bug in the
  whole change".
- **Care check-ins day 1/7/30/90** (`PostSalesCheckIn`). These are **medical messages, not
  marketing**: a new explicit `SendOpts.clinical` flag exempts them from the `optedOut`
  marketing suppression and the 12-in-30 ceiling, gated instead on the new
  `Lead.consentClinical` (null = assumed for a patient under care; only explicit `false`
  withholds). Safety flags and a missing template don't drop a check-in — they set it to
  **`blocked` with a reason** so it stays on the board as a task for a person.
- **The coordination rule** — at most **one care message per patient per IST day across all
  their journeys**. Due rows are processed by ascending day-offset so the clinically closer
  check-in claims the day and the other is pushed, with the reason shown in the UI. Keyed on
  the day the message actually goes out, so two rows overdue from different days can't both
  fire the same morning.
- **Handover summary per converted quote** — name, procedure, price, **which branch
  invoiced** (explicitly "not reported by billing" rather than passing the quoting branch
  off as fact), language, comms preferences, clinical-consent state, safety flags,
  counsellor notes, and every other quote open on the person. Snapshotted for the record,
  recomputed live for the volatile parts. Reads no transcripts or recordings.
- **Quote unlock now writes to the permanent log.** `unlockLeadQuote` required an admin and
  a reason but only wrote a Winston line; it now writes a `lead.quote.unlock` audit row with
  the reason, per "with a written reason in the permanent log".
- **Removed `Quote.journeyStage`** — an unwritten scaffold column that would have been a
  second source of truth beside `PostSalesJourney.stage`.
- Screens: `/post-sales` board, `/post-sales/[id]` journey, `/post-sales/policies`. Worker:
  check-in tick + SLA/reconcile pass. Backfill: `npm run backfill:journeys`.
- **Off by default:** `POSTSALES_CHECKINS_ENABLED` unset = schedules generate and display
  but nothing sends. The four WhatsApp templates are not yet approved, so every check-in
  currently lands as a human task.

Verified end-to-end against the local DB (40 assertions): two independent journeys on one
patient, per-treatment timings differing, backward-move reason enforcement, schedule
anchoring + idempotency, the coordination deferral, safety-flag blocking, and overdue
alert + dedup + reset.

**Not in this build** (next commit, design settled): calendar/appointments + reminders +
no-show, the authenticated invoice webhook driving conversion, 7-day branch-credit
disputes, daily ad-spend import.

### Follow-up, same day — found by running it

Driving the app in a browser (rather than trusting the assertions) turned up three things:

- **Customised roles never received the new capabilities.** `RolePermission` override rows
  replace a role's defaults wholesale, so the override rows for `front_desk`, `telecaller`
  and `branch_manager` meant the ERP was invisible to exactly the staff meant to use it. New
  `scripts/backfillRoleCapabilities.ts` (`npm run backfill:capabilities`, dry-run by
  default, audited) unions in only newly-introduced keys, only where the role has them by
  default — it never overrides an admin decision. It also reports customised roles that
  can't reach a gated route without changing them.
- **Login always redirected to `/dashboard`** and let the route guard bounce whoever
  couldn't see it. That worked, but the bounce happens inside the Server Action's soft
  navigation, so the URL bar was left reading `/dashboard` while a different page rendered —
  for every role without `analytics.view`, not just the new clinical ones. `authenticate`
  now resolves the role's real landing page up front (`landingPath`), and the login page
  redirects an already-signed-in user the same way. Access control was never bypassed — the
  rendered content was always the permitted page.
- **The board wrapped 5 stages into a 3+2 grid**, breaking the left-to-right pipeline
  reading and stranding an empty column mid-flow. Now one horizontally-scrolling row.

---

## 2026-07-29 — Compliance set (DPDP): recording consent, digital-source consent, retention/erasure

Backlog items C1–C3 (`docs/gaps-and-roadmap.md`). Additive schema change
(`Call.recordingConsent`) via migration `20260729073420_call_recording_consent` —
Railway's pre-deploy `migrate deploy` applies it automatically on push.

- **C1 — recording-consent disclosure + per-Call flag** *(code complete; the AI agent's
  spoken line is a config task on ElevenLabs).* New `Call.recordingConsent Boolean?`. The
  ElevenLabs mapper stores the agent's `recording_consent` data point. Human-handover (rep)
  calls now play a **patient-audible disclosure whisper** — `dialLeadTwiML` points the
  `<Number url>` at a new signature-verified `/api/twilio/whisper` route that Twilio plays
  to the patient before the legs bridge — and the recording webhook sets
  `recordingConsent=true`. Remaining: add the spoken disclosure line to the "Manish" agent
  prompt + have it emit `recording_consent` (see `elevenlabs-agent-integration.md` §7).
- **C2 — digital-source consent capture.** `ingestLead` now records consent for self-served
  digital sources (web_form / facebook / instagram / google / whatsapp): `consentMethod=
  digital_form`, `consentAt`, `consentCall`/`consentMarketing=true`, `consentUpdatedAt`, plus
  an immutable `lead.consent.change` audit row naming the basis (privacy-notice / ad-form
  acceptance). Staff-entered (manual/referral) sources assert nothing — consent captured
  elsewhere (walk-ins carry the explicit iPad/written form).
- **C3 — data retention / right-to-erasure.** Erasure (`permanentlyDeleteLead`) now deletes
  each call's audio from **Twilio** (`deleteTwilioRecording`) before cascading the DB rows.
  A scheduled **retention purge** (`lib/dataRetention.ts` `runRetentionPurge`, worker daily)
  redacts `recordingUrl` + `transcript` on calls older than `DATA_RETENTION_MONTHS` and
  deletes their Twilio audio, keeping non-PII shape (outcome/CQS/duration) + a
  `data.retention.purge` audit. **OFF by default** — no-op until the env is set. Residual:
  covers call recordings/transcripts only; message-body / lead-PII purge is a follow-up.

`tsc` + `next build` clean; 15 offline + DB assertions pass (mapping tri-state, whisper
wiring, retention math, delete guard, ingest consent capture). Docs: `gaps-and-roadmap.md`,
`elevenlabs-agent-integration.md`, `deferred-todo.md`. **Config follow-ups (deferred-todo):**
the C1 agent-prompt line, and choosing/setting `DATA_RETENTION_MONTHS` before go-live.

## 2026-07-29 — Security hardening: webhook auth + replay guard + opt-out re-check

Quick-wins batch from the security/reliability backlog (`docs/gaps-and-roadmap.md`
S3, S4, R5). No schema, env, or migration change.

- **S3 — authenticate the Twilio voice webhook.** `/api/twilio/voice/[leadId]` was
  public, so a guessed cuid returned the patient's phone number inside the TwiML. It
  now verifies `X-Twilio-Signature` over the exact signed URL (base + path + query,
  incl. `repId`) for both POST and GET, returning 403 on mismatch — mirrors the
  recording webhook. (XML-escaping of interpolated values was already in place via
  `dialLeadTwiML`/`xmlEscape`.)
- **S4 — ElevenLabs replay guard.** `verifyElevenLabsSignature` now rejects a signed
  timestamp outside a 5-minute window (or a non-numeric `t`) before the HMAC check,
  so a captured request can't be replayed. *Manual signed-webhook replay tests now
  need a fresh timestamp.*
- **R5 — opt-out re-check in `recordCall`.** A lead who opted out (WhatsApp STOP)
  between a call being placed and its result arriving still got stage advance, retry,
  handover, and templates. `recordCall` now early-guards on `lead.optedOut`: it
  persists the Call for the record and returns, skipping CQS spend, stage advance,
  retry, handover, template sends, and campaign enrollment (P2002-race-safe). Distinct
  from an opt-out decided ON the call (`outcome === "not_interested"`).

`tsc` + `eslint` clean; S4 replay window verified offline (fresh passes;
stale/future/bad-HMAC rejected). Backlog statuses updated in `gaps-and-roadmap.md`.

## 2026-07-28 — Follow-up campaigns: visibility UI (per-lead card + /campaigns overview)

Surfaces running campaigns in the app (previously only visible in Prisma Studio / the audit
log) and lets staff pull a lead out.

- **Per-lead card** on the lead detail page — active campaign (or most-recent as history):
  name, `messages sent / total`, next-touch time (window end for hot-lead routing), + a Stop
  button. `components/LeadCampaignCard.tsx`.
- **`/campaigns` overview** — all active enrollments grouped by campaign type, counts,
  next-touch, per-row Stop. `app/(dashboard)/campaigns/page.tsx`.
- Read models `lib/campaigns/enrollments.ts` (`getLeadCampaign` / `listActiveCampaigns`).
- **Stop** — new `campaigns.manage` capability (telecaller, telecalling head, branch manager,
  sales head, + admin); server action `stopLeadCampaign` → `stopEnrollmentForLead(...,
  "stopped_by_staff", actor)`, actor-attributed audit, and it does **not** reactivate a Lost
  lead (that stays reserved for a genuine reply). `stopEnrollmentForLead` gained an optional
  actor arg. New nav link + `/campaigns` route guard.

No schema change. `tsc` + `next build` clean; read helpers + actor-attributed stop verified
against the dev DB. Docs: flows/08 + this entry.

## 2026-07-28 — Follow-up campaigns: Hot-Lead Fast-Track routing (Stage 3)

`hot_lead` becomes a real **routing** campaign — no messaging. Enrolling a lead is a
fast-track marker; the actual "counsellor calls within 2h" reuses the existing handover +
SLA path (no new timer/alert).

- **`CampaignDef.routing`** flag; `hot_lead` marked `routing: true` (still stepless).
- **Classifier** (`lib/campaigns/classify.ts`) gains a `hotLead` signal and routes it to
  `hot_lead` *before* the generic "handover → no campaign" rule (a hot lead's campaign IS the
  handover). `lib/callIntake.ts` passes `hotLead = handover fired `high_cqs`` into the
  existing post-commit enroll — no new call site.
- **Enrollment** (`lib/campaigns/engine.ts`): routing campaigns enforce the **per-branch
  toggle at the door** (`branch_disabled`, since there's no send-tick to pause in) and set
  `nextRunAt = now + HANDOVER_SLA_HOURS` (reused, default 2h). The tick **completes** the
  marker when that window elapses (`routing_window_elapsed`) — sends nothing, runs no gate.
- New eligibility helper `isBranchCampaignEnabled()`.

No schema change; no new env (reuses `HANDOVER_SLA_HOURS` + `CAMPAIGNS_ENABLED`). `tsc` +
`next build` clean; verified 14 classifier cases + 9 engine integration assertions against the
dev DB (enroll window, one-active-per-person, before/after-window tick, routing teardown,
branch-toggle-off refused at the door). Docs: flows/08 + this entry.

## 2026-07-28 — Follow-up campaigns: Win-Back auto-sweep + Dead-Lead review queue

Winning back lost leads (§follow-up).

- **Automatic Win-Back** — a worker sweep (`lib/campaigns/winback.ts` `runWinBackSweep`, every
  `WINBACK_SWEEP_HOURS`, default 12) enrols leads Lost for `WINBACK_AFTER_DAYS`+ (default 90)
  into `win_back` (one warm message), **max 4/yr**, consent- and opt-out-checked, deduped per
  lost-event via `Lead.lastWinBackAt` (only re-fires if the lead was lost *again* since).
- **Dead-Lead review queue** — `/win-back` lists leads Lost in the last 30 days for a Sales /
  Telecalling Head to approve (singly/in a batch) for the `dead_lead_bulk` "one more try".
- **Re-engagement** — a genuine reply to a win-back / dead-lead campaign reactivates the Lost
  lead → **Human Callback Pending** and pings the owner (`reactivateLostLead`).
- New **`telecalling_head`** role + **`campaigns.winback`** capability; `/win-back`
  route-guarded + nav-gated. `win_back` / `dead_lead_bulk` gain their single-step schedule.
- Schema: `Lead.lastWinBackAt` (migration `20260728063829`). Env:
  `WHATSAPP_TEMPLATE_WINBACK` / `WHATSAPP_TEMPLATE_DEADLEAD` + win-back tuning vars.

## 2026-07-28 — Follow-up campaigns: nurture drips + auto-enrollment (Stage 2)

Builds on the Stage 1 engine/guardrails: the two WhatsApp nurture campaigns now have
schedules, and leads are sorted into a campaign **automatically from how the AI call went** —
no hand-tagging.

- **Worried About Cost** — value/financing on days 1/3/7/14 (`WHATSAPP_TEMPLATE_WC_DAY1/3/7/14`).
- **Just Researching** — weekly educational content, 6 weeks (`WHATSAPP_TEMPLATE_JR_WK1..6`);
  the step count *is* the spec's "max 6 messages" cap.
- **Call → campaign classifier** (`lib/campaigns/classify.ts`) — from signals the ElevenLabs
  agent already emits. Order (user-approved, **handover always wins**): unreachable →
  `couldnt_reach`; retry-pending / opt-out / handover / booked / callback → none; a cost
  signal in the tag or handover reasons (price/EMI/budget/financing…) → `worried_cost`;
  `interestLevel=high` without handover → none (left for a human); else → `just_researching`.
- **Centralized auto-enrollment** — `lib/callIntake.ts` now runs the classifier once
  post-commit for every recorded call and enrolls the result (replacing Stage 1's inline
  couldnt_reach enroll). `enrollLead` self-guards, so null/already-enrolled is a safe no-op.

No schema change. `tsc` + `next build` clean; classifier verified (13 cases incl. the
snake_case `price_request` boundary fix — underscore is a word char, so keys are normalized
before the cost-word match). Docs: flows/08 + this entry.

## 2026-07-28 — Follow-up campaigns: engine + guardrails (Stage 1)

Phase 2's biggest revenue item begins: leads that ignore the AI calls + first WhatsApp no
longer vanish — they enter an automated follow-up **campaign**, wrapped in hard guardrails so
it can never become harassment. Stage 1 ships the **engine + all four guardrails + per-branch
controls + one proof campaign** ("Couldn't Reach Them"). The other six campaigns are declared
(so the per-branch toggles list them) but have no steps yet.

- **The guardrail gate** (`lib/campaigns/eligibility.ts`) — every send passes through, first
  failure wins: hard exclusions (minor/legal/complaint — no toggle overrides) → opt-out →
  reply-stops-everything → **12-in-30 person-level ceiling** → branch quiet hours → per-branch
  toggle. Stops are terminal; ceiling/quiet-hours defer; a disabled toggle pauses (reversible).
- **One campaign per person, never per quote** — enforced by the DB: a partial unique index
  `("leadId") WHERE status='active'` on `CampaignEnrollment` makes a second active enrollment
  impossible. Two open quotes → the higher-value/sooner-expiring one *selects* the campaign
  (`drivingQuoteId`, context only); enrollment + ceiling + guardrails follow the person.
- **The engine** (`lib/campaigns/engine.ts`) — `enrollLead` / `stopEnrollmentForLead` /
  `runCampaignTick`. The tick (worker interval, `CAMPAIGN_TICK_MINUTES`, default 15) advances
  each due enrollment: gate → send step template → schedule next, or complete + terminal action.
- **Couldn't Reach Them** — auto-enrolled from `lib/callIntake.ts` when the call ladder
  exhausts; messages on days 1/5/14/30 then marks the lead **Lost** (premature-loss aware).
- **Reply-stop** wired into the inbound WhatsApp webhook — any reply halts the active campaign.
- **Per-branch controls** on the Branches screen — quiet hours (default 20:00–09:00 IST) +
  a per-campaign on/off switch (`setCampaignEnabled`, audited `settings.campaign.toggle`).
- **Global kill-switch** `CAMPAIGNS_ENABLED` (env), **OFF by default** — nothing enrols or
  sends until explicitly enabled, so deploying the code messages no one by surprise.

Schema: `CampaignEnrollment`, `CampaignSetting`, `Branch.quietStartHour`/`quietEndHour`
(migration `20260727183850_campaigns_stage1`, incl. the hand-added partial unique index).
Guardrails verified against the dev DB (13 invariants: enrollment uniqueness, ceiling defer,
reply-stop, exclusion, quiet-hours wrap, stop/re-enroll). New flow doc:
[flows/08-follow-up-campaigns.md](flows/08-follow-up-campaigns.md).

## 2026-07-27 — Prisma migrations baseline (versioned schema over `db push`)

Schema changes are now versioned, reviewable migrations instead of imperative
`db push`. Commit `0876251` (merge of `c4ce048`).

- **Baseline migration** `prisma/migrations/0_init/migration.sql` captures the current
  full schema (17 tables, 49 indexes, 22 FKs), generated via
  `prisma migrate diff --from-empty`. Adds `migration_lock.toml` (provider = postgresql).
- **Railway pre-deploy** (`railway.json`) switched from `npx prisma db push` to
  `npx prisma migrate deploy` — no more silent drift; every schema change ships as a
  reviewed migration file.
- **New npm scripts**: `db:migrate:deploy`, `db:migrate:resolve`.
- **One-time baselining**: existing DBs already contain the `0_init` tables, so each
  must be marked applied once with `prisma migrate resolve --applied 0_init` before the
  first `migrate deploy` (else it re-runs `0_init` and errors). Local dev **and prod**
  are now baselined; prod `migrate status` reports "up to date".

Going forward: create schema changes locally with `npm run db:migrate` (`migrate dev`),
commit the generated migration, and Railway applies it on deploy. `db:push` remains only
for throwaway local experiments. Supersedes the "run `npm run db:push`" note in prior
entries.

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
