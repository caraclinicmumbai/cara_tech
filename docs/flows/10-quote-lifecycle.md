# 10 — Quote lifecycle (§multi-quote)

How a price becomes a quotation, a quotation becomes money, and money becomes a
post-sales journey. This is the commercial track: it runs alongside the lead's
person-track ([flow 3](03-post-call-cqs-and-stage.md)) and hands off to the clinical
track ([flow 9](09-post-sales-journey.md)) at exactly one point — conversion.

## The one structural rule

**The lead is the person. The quote is the treatment.**

A lead never "converts" — its quotes do. Someone can be quoted a hair transplant and a
PRP course, reject one and convert the other, and come back next year for a second
transplant. That's four quotes on one person, and the person's record stays open
throughout.

Three consequences run through the whole subsystem:

| Rule | Enforced by |
|------|-------------|
| **One OPEN quote per treatment at a time.** A second is refused — revise the first. | `createQuote()`, matching on a case/space-normalised `treatmentKey()` |
| **A new `cycle` only starts once the previous quote for that treatment is closed.** `cycle` = how many times this person has been quoted this treatment. | `createQuote()` — `cycle = sameTreatment.length + 1` |
| **On conversion the QUOTE locks. The LEAD never locks.** | `transitionQuote()` sets `lockedAt`; nothing touches the lead |

That last one is called out in the code as the single most likely bug in this area
([lib/quotes.ts](../../lib/quotes.ts)): locking the person instead of the treatment would
strand every other quote they have in play.

## Trigger

A counsellor raises a quote from the **Quotes panel on a lead**
([components/QuotesPanel.tsx](../../components/QuotesPanel.tsx)) — there is no other
entry point. Quotes are not raised by the AI, by intake, or in bulk.

The prompt to raise one usually comes from elsewhere in the system: a `price_request`
handover trigger ([lib/handover.ts](../../lib/handover.ts)), or a `quote`-channel step on
the lead's follow-up roadmap ([lib/followups.ts](../../lib/followups.ts)).

## Step by step

### 1. Raise (`drafted`)

`createLeadQuote()` → `createQuote()`.

- **Treatment** comes from the catalog picker ([lib/catalog.ts](../../lib/catalog.ts)),
  which reads the clinic's `CatalogItem` master list and auto-fills base price, GST rate,
  and a package's built-in discount %. Free text is still accepted for anything off-list.
- **Source is compulsory** — `ad` | `asked_during_consultation` | `post_op_upsell` |
  `existing_patient_repeat`. Attribution stops at the door the patient came through *for
  this treatment*; it does not follow them around. Enforced server-side, because the
  Server Function is reachable by direct POST.
- **Branch** is the creating user's home branch. It decides which legal entity, GSTIN,
  bank details and address the PDF renders ([lib/branches.ts](../../lib/branches.ts)) —
  distinct from `invoicedBranchId`, which billing sets later.
- **Owner** defaults to the creating user's sales-rep identity, and may differ from the
  lead's owner from then on.
- **Expiry** is stamped at creation: `QUOTE_DEFAULT_VALIDITY_DAYS` = 30 days.
- A priced quote is created with an **opening `QuoteVersion`**. That row is the starting
  price, not a revision — anything counting revisions must subtract it.

### 2. Price it

Order of operations, and it matters:

```
discount is taken off the BASE first
        ↓
GST (2.5% CGST + 2.5% SGST = 5%) is charged on the DISCOUNTED amount
        ↓
total payable = (base − discount) + GST
```

One pure function — `computeQuoteTotals()` in
[lib/quoteStages.ts](../../lib/quoteStages.ts) — is the single implementation, used by the
panel, the PDF, and the Open Quotes desk alike, so none of them can drift from the others.
It runs on client and server, rounds to whole rupees, and clamps a discount so it can
never take the base below zero.

`gstRate` is **stored per quote**, not read from a constant at render time, so a historical
quote keeps the rate it was raised under. Catalog items marked "NA" carry 0%.

Discount is either `percent` (of the base, decimals allowed — `12.5`) or `inr` (a flat
rupee amount).

### 3. Revise — never re-raise

`reviseLeadQuotePrice()` → `reviseQuotePrice()`.

Revising **replaces the live version**: the current `QuoteVersion` is marked `replaced`, a
new one is appended with an optional note, and the quote's `price` / `totalPayable` are
recomputed off the *existing* GST and discount. The quote keeps its id, its cycle, and its
full price trail. All three writes are one `$transaction`.

Refused on a locked quote.

### 4. Send (`drafted → sent`)

`sendLeadQuoteWhatsApp()` builds the PDF in memory
([lib/quotePdf.ts](../../lib/quotePdf.ts) — nothing is stored) and sends it as a WhatsApp
document on the lead's existing thread ([flow 6](06-whatsapp-messaging.md)). On success a
`drafted` quote advances to `sent`; a further-along quote is not regressed.

Inside the 24h service window it goes as a plain document. Outside it, the send falls back
to an approved document template named by `QUOTE_DOC_TEMPLATE_NAME` — without that
variable set, a proactive send is not possible.

The same PDF is downloadable at `/api/quotes/[id]/pdf`, gated on `quotes.view` **and** lead
ownership, and every download writes a `record.view` audit row.

### 5. Move it along

| Status | Meaning |
|---|---|
| `drafted` | raised, not yet sent |
| `sent` | the PDF has gone to the patient |
| `viewed` | the patient engaged with it |
| `accepted` | → **immediately stored as `awaiting_payment`** |
| `awaiting_payment` | accepted, money not yet in |
| `converted` | a real invoice exists |
| `in_treatment`, `completed` | the treatment is under way / done |
| `rejected`, `expired`, `replaced`, `withdrawn` | terminal, not won |

**Acceptance is not conversion.** `transitionQuote()` rewrites `accepted` to
`awaiting_payment` on the way in, so "they said yes" can never be mistaken for "the money
arrived". The UI labels the action *"Accepted — Awaiting Payment"* to match.

**Nothing is ever deleted.** A quote that dies is `rejected` (reason **mandatory, and from
`QUOTE_REJECTION_REASONS`**) or `withdrawn` (free-text reason mandatory). Either way
`closedById` records the name against it.

Status groupings used across the app — `OPEN_QUOTE_STATUSES`, `WON_QUOTE_STATUSES`,
`CLOSED_QUOTE_STATUSES` — all live in [lib/quoteStages.ts](../../lib/quoteStages.ts).

### 6. Convert — the one-way door

`converted` requires the separate `quotes.convert` capability. It:

1. stamps `convertedAt` **and** `lockedAt` — the quote becomes read-only;
2. records `invoicedBranchId` when billing supplies it (the invoicing branch earns the
   credit, which may not be the branch that raised the quote);
3. opens the **post-sales journey** via `openJourneyForQuoteSafe()`.

The journey opens *after* the quote row commits and is deliberately best-effort: the money
has already moved, so a journey hiccup must never fail the conversion. Anything missed is
swept up by `reconcileMissingJourneys()` in the worker. See
[flow 9](09-post-sales-journey.md).

Reopening a converted quote is `unlockQuote()` — Admin only (`quotes.unlock`), always with
a written reason, and it drops the quote back to `accepted`.

### 7. The internal history summary

Once a quote has converted, a **Patient History Summary** PDF becomes downloadable from
the quote's card on the lead (`🗂 History PDF` → `/api/quotes/[id]/history`). It is
rendered on demand and never stored, like the quotation itself.

It contains, for that converted treatment:

| Section | Content |
|---|---|
| Ownership | Quote owner (the telecaller who sold it), lead owner, stage, first-contact date, source, campaign |
| Quotation | Status, attribution, base → discount → GST → payable, branches, the full price trail, and the patient's other quotes |
| Clinical context | Stated interest, what they asked for, preferred language, clinical consent, safety flags, and clinical notes from the post-sales journey |
| Conversations | Every call: outcome, sentiment, duration, CQS, objection type, handler, and the one-line AI summary |
| Every contact, in order | One chronological log merging calls, WhatsApp both ways, staff notes, completed follow-up steps, care check-ins, and the quote/conversion events |
| Transcripts | Verbatim call transcripts, appended (each capped at 6,000 characters, with the truncation stated in the document) |

**This is the deliberate inverse of the post-sales handover summary.** That document
withholds transcripts and recordings because the clinical team must not see them
([flow 9](09-post-sales-journey.md)). This one includes them, so the route is gated on
**both `quotes.view` and `calls.view`** — and none of `doctor`, `ot_team` or
`post_sales_consultant` hold either, which is what keeps that rule intact. Lead-ownership
scoping applies on top, so a counsellor cannot pull a patient they can't already see.

Every download writes a `record.view` audit row naming the actor and how much they got
(call count, message count, transcript count). The document is stamped
`INTERNAL — not for the patient` on every page.

> **There is no medical history in the CRM to include.** The schema has no field for
> conditions, allergies, medications or an intake questionnaire. The PDF says so in
> plain words rather than leaving a blank section that reads like a clean bill of
> health, and prints the clinically-relevant data that *does* exist. If a real medical
> history is wanted here, it has to be modelled and captured first.

## Who can do what

| Capability | Holders | What it unlocks |
|---|---|---|
| `quotes.view` | telecaller, telecalling head, branch manager, sales head, admin | See quotes, download the PDF, reach `/quotes` |
| `quotes.manage` | same | Raise, revise, send, reassign, move status (except conversion) |
| `quotes.convert` | same | Mark converted — the money step |
| `quotes.unlock` | admin only (wildcard) | Reopen a locked quote, with a reason |

Every server action re-checks its capability **and** re-checks lead access
(`userCanAccessLead`, grant-aware), because Server Functions are reachable by direct POST.

Defaults above; a `RolePermission` override row saved from the Hierarchy screen is
authoritative and replaces a role's built-in list wholesale — see the warning in
[flow 9](09-post-sales-journey.md#️-customised-roles-do-not-receive-new-capabilities).

## Where quotes show up elsewhere

| Surface | What it uses quotes for |
|---|---|
| **Open Quotes desk** `/quotes` | Every quote still in play: value, owner, money breakdown, expiry, and the audited activity trail. [lib/openQuotes.ts](../../lib/openQuotes.ts) |
| **Converted quotes** (same page, below) | The won side of the desk — what closed, for how much, when, how many days it took, and which branch billed it. Deliberately leaner than the pipeline table: staleness, expiry and the chase trail mean nothing for settled work. Value totals cover everything in scope even when the list is capped at 50 rows, so a truncated table never understates what was won. Follows the page's ownership scope and branch filter; the pipeline pills don't apply. `getConvertedQuotes()` |
| **Leads table** — Deal amount | Total of the lead's won quotes; falls back to the latest open one. [app/(dashboard)/leads/page.tsx](<../../app/(dashboard)/leads/page.tsx>) |
| **Follow-up campaigns** | When two quotes are open, the higher-value one (tie-broken by soonest expiry) *selects* the campaign — but enrollment still follows the person. [lib/campaigns/engine.ts](../../lib/campaigns/engine.ts) |
| **Stuck-in-stage SLA** | A lead with any won quote is skipped — it has already realised value. [lib/stageSla.ts](../../lib/stageSla.ts) |
| **Post-sales** | One journey per converted quote. [flow 9](09-post-sales-journey.md) |
| **Billing** | An invoice is what converts a quote, and it names the branch that earns the credit. See below. |

### Who sees which quotes on the desk

The desk is a **personal work list**, so a counsellor (an "own scope" role) sees:

- **quotes she owns** — wherever the patient has since ended up. A handover moves the
  lead; it doesn't take her quote off her board.
- **plus unowned quotes on her own leads** — somebody has to work them, and hiding them
  from every counsellor would leave real money invisible.

She does **not** see a colleague's quote merely because she owns the patient — owning the
lead is not owning the quote (§multi-quote is explicit that the two owners can differ).
Managers and admins see the whole board, unchanged.

These are one `OR`, not two filters ANDed: see `quoteWhereForUser()` in
[lib/authz.ts](../../lib/authz.ts). Ordering them the other way took a counsellor's own
quote off her board as soon as the lead moved to a colleague.

> The **lead page** is unaffected: open a patient and you see all their quotes, because
> that's the context you need to work them. Only the desk is scoped.
>
> Consequence worth knowing: a counsellor can hold a quote on a lead she can't open. The
> board names the patient; opening the record still needs the lead or a temporary access
> grant.

## Invoiced = converted (§billing)

**"Converted" means an invoice exists for that specific quote.** Not a counsellor's
optimism and not a status someone picked — a document billing raised.

- `POST /api/webhooks/invoice` (shared secret, `x-webhook-secret`) takes
  `{ invoiceNumber, quoteId, branchId | branchName, amount, issuedAt?, externalId?, source? }`.
  `lib/invoices.recordInvoice` writes an `Invoice` row, sets the quote's
  `invoicedBranchId` from it, and transitions the quote to `converted` — which stamps
  `convertedAt`, locks the quote, and opens the post-sales journey exactly as before.
- **Attached to the QUOTE, never the lead.** A patient can have a transplant invoiced at
  one branch and a PRP course at another; a lead-level field would force us to pick one
  and misreport the other. Two quotes, two invoices, two independent conversions.
- **The invoicing branch earns the credit**, read from the invoice — nobody types it.
  The quote may be *raised* at one branch and *billed* by another; the desk and the PDF
  show both.
- **Marking a quote converted by hand is refused** ("A quote converts when it's
  invoiced…"). The escape hatch is admin-only: `recordQuoteInvoiceAction` records a real
  invoice with `source: "manual_admin"` and a mandatory reason, shown on the quote as
  *recorded by hand*. So even the override leaves an invoice and an audit entry.
- **Idempotent** on the invoice number — billing systems retry. The same number against a
  different quote is refused (422), not silently re-pointed.
- **No card or bank details, ever.** An invoice here is a number, an amount, a branch and
  a date. Anything else in the payload is ignored.

### Until billing is connected (§settings)

The rule above assumes something is sending us invoices. **Nothing is yet** — no billing
integration exists (see [deferred-todo.md](../deferred-todo.md)) — so enforcing it would
leave the clinic unable to record sales it genuinely made.

`quotes.allowUninvoicedConversion` (Settings → Quotes & billing, admin-only) lifts the
requirement. While it is **on**:

- anyone with `quotes.convert` can mark a quote Converted directly;
- the conversion is flagged `uninvoiced: true` in the audit log, so these stay
  identifiable later, when every other conversion has an invoice behind it;
- **the credit falls to the branch that RAISED the quote** (`Quote.branchId`) rather than
  being read off an invoice. It's the only defensible guess, it's recorded as a guess
  (`creditAssumedBranchId`), and the 7-day dispute below is there to move it;
- the counsellor is told all of this when the conversion goes through, rather than
  discovering it in a report.

**Turn it off the day billing is wired up.** Conversion then goes back to meaning a real
invoice exists, with no code change. The admin by-hand override stays available either
way, and remains the cleaner path because it leaves a real `Invoice` row.

The switch is stored in `AppSetting` and read through `lib/settings.ts` (30s cache).
Every flip is audited with the actor and a reason.

### The credit, and the 7-day dispute (§branch credit)

**The branch that raised the invoice gets the credit for that quote.** There is no field
to type it into — it's read off the invoice, so the argument can't start. A patient's
transplant at Andheri and PRP course at Bandra credit their own branches independently,
because credit lives on the quote.

The one release valve (`lib/branchCredit.ts`):

- A branch that believes the credit is theirs has **7 days from the credit landing** to
  dispute, in writing, with a mandatory reason. Branch managers raise it for **their own**
  branch — the claimant is their home branch, never a dropdown, so nobody files on
  someone else's behalf. `quotes.disputeRaise`.
- **One dispute per quote**, enforced by a unique key. The window deadline is stored on
  the dispute, not recomputed, so changing the policy later can't retroactively invalidate
  a dispute that was in time.
- **The Sales Head decides, once** (`quotes.disputeDecide`), with a mandatory note.
  Upholding moves the credit to the claimant — **the only path by which a credit ever
  moves**. Rejecting leaves it. Either way the dispute closes for good: a decided dispute
  can't be reopened or re-decided.
- Both the raising and the decision are written to the lead's audit trail
  (`lead.quote.credit.dispute` / `lead.quote.credit.decision`) with the branches on either
  side, and the Sales Head gets a bell when one is waiting.


## Key files

| File | Role |
|------|------|
| [lib/quoteStages.ts](../../lib/quoteStages.ts) | Statuses, groupings, sources, rejection reasons, `computeQuoteTotals()` |
| [lib/quotes.ts](../../lib/quotes.ts) | Domain rules: create, revise, transition, reassign, unlock |
| [app/(dashboard)/leads/quoteActions.ts](<../../app/(dashboard)/leads/quoteActions.ts>) | Server Actions — capability + lead-access checks, validation, audit |
| [components/QuotesPanel.tsx](../../components/QuotesPanel.tsx) | The per-lead panel: the only place a quote is raised or edited |
| [lib/quotePdf.ts](../../lib/quotePdf.ts) | The quotation document, rendered on demand |
| [app/api/quotes/[id]/pdf/route.ts](<../../app/api/quotes/[id]/pdf/route.ts>) | PDF download — gated, ownership-scoped, audited |
| [lib/openQuotes.ts](../../lib/openQuotes.ts) | Read model for the Open Quotes desk |
| [lib/patientHistory.ts](../../lib/patientHistory.ts) | Assembles the internal history record for a converted quote |
| [lib/historyPdf.ts](../../lib/historyPdf.ts) | Renders that record as the multi-page history PDF |
| [app/api/quotes/[id]/history/route.ts](<../../app/api/quotes/[id]/history/route.ts>) | History download — gated on `quotes.view` + `calls.view`, ownership-scoped, audited |
| [lib/catalog.ts](../../lib/catalog.ts) | Treatment picker — prices, GST, package discounts |

## Configuration

| Setting | Where | Effect |
|---|---|---|
| `QUOTE_DEFAULT_VALIDITY_DAYS` = 30 | `lib/quoteStages.ts` | Expiry stamped at creation |
| `CGST_RATE` / `SGST_RATE` = 2.5 each | `lib/quoteStages.ts` | Default GST; the rate is then stored per quote |
| `STALE_AFTER_DAYS` = 7 | `lib/openQuotes.ts` | "Gone quiet" threshold on the desk |
| `EXPIRING_WITHIN_DAYS` = 7 | `lib/openQuotes.ts` | "Lapsing" threshold on the desk |
| `TRANSCRIPT_MAX` = 6000 | `lib/historyPdf.ts` | Characters of each transcript printed in the history PDF before it is cut (truncation is stated in the output) |
| `QUOTE_DOC_TEMPLATE_NAME` / `_LANG` | env | **Optional override.** Pins which approved document template sends a quote outside the 24h window. Unset, the app asks the WABA for an approved template with a DOCUMENT header and uses it — the send shouldn't be silently disabled in one environment because an env var wasn't copied. Set it only when several document templates exist and the choice matters. |
| Catalog items | `CatalogItem` table, admin-managed | The treatment picker's prices, GST rates, package discounts |

## Limitations

- **Nothing expires a quote automatically.** `expiresAt` is written at creation and read
  for display, but no sweep ever flips a lapsed quote to `expired` — it sits in
  `OPEN_QUOTE_STATUSES` indefinitely, still counting toward pipeline value and still
  blocking a new cycle for that treatment. Someone must move it by hand.
- **The spec's "nudge 48h before expiry" is not implemented.** There is no job and no
  notification. The closest thing is the *Lapsing* tile on `/quotes`, which a manager has
  to go and look at.
- **Conversion is typed, not billed.** `converted` is a human clicking a button; no invoice
  webhook verifies that money actually arrived, and `invoicedBranchId` is only set if a
  caller passes it. Branch conversion credit is therefore as accurate as the person
  clicking.
- **`replaced` is a status no code sets.** Revisions replace a `QuoteVersion`, never the
  quote, so the quote-level `replaced` status exists in the enum but is unreachable in the
  current flows.
- **Quote activity is audited against the lead**, with the quote in `meta.quoteId`. There
  is no index on that JSON path, so anything wanting a per-quote trail has to fetch by lead
  and regroup — which is what `lib/openQuotes.ts` does. Fine at clinic scale; it would need
  a real index or a `quoteId` column before it isn't.
- **No bulk actions and no quote-level search.** The desk filters by status, owner, branch
  and the three problem pills; there's no free-text search across patients or treatments,
  and no way to act on several quotes at once.
- **The history PDF has no medical history to print.** No conditions, allergies,
  medications or intake questionnaire exist in the schema, so the document prints the
  clinically-relevant data that does exist and states the absence outright.
- **The history PDF is generated on demand, not at conversion.** Nothing is snapshotted,
  so a record pulled today reflects the patient as they are today, not as they were the
  day they converted. The handover summary on the journey is the frozen snapshot.
- **A withdrawn/rejected quote can't be reopened** — only a *converted* one can, via
  `quotes.unlock`. Reviving a rejected quote means raising a new cycle.
