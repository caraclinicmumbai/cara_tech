# 12 — Reports (§reports)

Ten management read-outs at `/reports`, over one shared date range. The Dashboard
answers *"what's happening right now"*; this answers *"what happened, and is it getting
better."*

Everything here is read-only and derived — no report writes anything, and no number on
these pages is typed by a human. The one exception is ad spend, which has to be
imported because nothing in the CRM knows what a click cost (see
[Ad spend](#ad-spend-the-cost-side) below).

## The reports

| # | Report | Answers |
|---|---|---|
| 1 | Lead Inflow | How many leads arrived, from where, on which days |
| 2 | AI Contact Rate | How many of them the AI actually reached |
| 3 | Handoff Speed | How fast a counsellor picked up what the AI handed over |
| 4 | Counsellor Performance | Leads handled, consultations booked, quotes, conversions |
| 5 | Source Attribution | Cost per lead, per consultation, per surgery |
| 6 | Lost Lead Analysis | Why we lose people before they're ever quoted |
| 7 | 💰 Treatment Mix | What we quote, what converts, at what value |
| 8 | 💰 Lost Quote Analysis | Quotes rejected, withdrawn or lapsed — and the pricing signal |
| 9 | 💰 Multi-Quote | How often one patient buys two treatments, and which pairs |
| 10 | 💰 Repeat Treatment | Who comes back, how long they take, what it's worth |

## Who sees what

Two capabilities, because the reports answer to different people.

| Capability | Covers | Granted by default to |
|---|---|---|
| `reports.view` | Reports 1–6 and the page itself | Telecalling Head, Branch Manager, Sales Head, Admin |
| `reports.revenue` | The four 💰 reports, plus the money columns inside 4 and 5 | Branch Manager, Sales Head, Admin |

A tab the viewer can't hold isn't rendered, and its URL falls back to the first tab
they can see rather than erroring. Both are editable on `/hierarchy` like any other
capability.

## The date range

One range for the whole page, held in the URL (`?preset=30d` or `?from=&to=`), so it
survives switching tabs and can be shared as a link. Presets are 7 / 30 / 90 / 365 days
ending today; the two date inputs take anything else.

**Ranges are IST calendar days, inclusive of both ends.** `lib/reports/range.ts` is the
only implementation — a range is `[IST midnight on from, IST midnight on the day after
to)`. Doing this the obvious way (`new Date("2026-08-30")`) gives UTC midnight, which is
05:30 IST, so everything the clinic did before breakfast lands in the previous day's
bucket. Every daily count on every report depends on that one function being right.

## The rules the numbers obey

These are shared across all ten reports (`lib/reports/shared.ts`), so the tabs can't
disagree with each other.

- **Null is not zero.** Every rate whose denominator is zero renders as an em dash, never
  as "0%". A report that prints 0% for *"there was nothing to divide by"* is worse than
  one that admits it doesn't know.
- **Reached** (report 2) means a person answered and a decision was recorded — so a firm
  "not interested" counts as a contact. The AI did its job; the answer was no. Calls with
  no outcome written back are attempts, never contacts.
- **Picked up** (report 3) means a *logged* action: a call recorded against the lead, or a
  counsellor-typed WhatsApp message. A counsellor who dials from their own handset leaves
  no trace and reads as never picked up — the same blind spot the handover SLA has.
- **Consulted** means the stage says so **or the patient bought something** — you cannot
  have a treatment without being consulted. Without that second clause, a patient who
  converted while their stage still read "in consideration" produced consult-to-surgery
  rates above 100%.
- **A quote is worth its invoice** where one exists, and its quoted total (after discount,
  including GST) where one doesn't. The invoice is the fact; the quote is the estimate.
- **A surgery is a converted quote**, so a patient taking two treatments is two surgeries —
  that's what cost-per-surgery divides by. Rates that would otherwise exceed 100% count
  *patients* instead.
- **Treatments are matched by name**, case- and space-insensitively (the same rule as the
  one-open-quote-per-treatment check). Two sizes of the same procedure count as two
  treatments, which is usually right — they're priced and sold separately.

## Ad spend — the cost side

Report 5 needs to know what the ads cost, and nothing in the CRM does. It's imported into
the `AdSpend` table, one row per (IST day, source, campaign).

**A day nobody imported is "unavailable", never zero.** This is the rule the whole report
is built around: if a missing Tuesday counted as ₹0, every cost-per-lead would read lower
than the truth, and the cheapest-looking channel would be whichever one we forgot to
import — which is exactly the direction that moves budget. So:

- A day with genuinely no spend must be imported as an explicit **0**.
- A day with no row is a hole, and every cost figure covering it is **withheld**, with the
  number of missing days named on screen.
- A total spend is only stated when *every* paid source is complete for the range.

Two ways in, both idempotent — re-importing a day replaces it, because the platforms
restate spend for a day or two after the fact:

```bash
# CSV (Meta / Google exports; headers matched loosely, ₹ and commas tolerated)
./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/importAdSpend.ts spend.csv            # dry run
./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/importAdSpend.ts spend.csv --apply --zero-fill
```

```http
POST /api/webhooks/ad-spend       x-webhook-secret: <WEBHOOK_SECRET>
{ "entries": [ { "day": "2026-08-30", "source": "facebook", "amount": 12500, "campaign": "Monsoon" } ] }
```

`--zero-fill` writes an explicit 0 for every (day, source) inside the file's range that
the file didn't mention — without it, one quiet Sunday makes the whole range unavailable.

Paid sources are `facebook`, `instagram`, `google` (they must match `Lead.source`).
Unpaid sources — referral, walk-in, website — have no ad cost, and their cost cells are
blank rather than zero.

## Where the code lives

| Piece | File |
|---|---|
| Date range, IST days | `lib/reports/range.ts` |
| Shared definitions & formatting | `lib/reports/shared.ts` |
| Reports 1–3 | `lib/reports/funnel.ts` |
| Report 4 | `lib/reports/people.ts` |
| Report 5 | `lib/reports/attribution.ts` |
| Reports 6 & 8 | `lib/reports/lost.ts` |
| Reports 7, 9, 10 | `lib/reports/money.ts` |
| Ad spend + coverage | `lib/adSpend.ts` |
| Page, tabs, capability gate | `app/(dashboard)/reports/page.tsx` + `sections/` |
| Presentational primitives | `components/ReportUI.tsx`, `components/ReportRangePicker.tsx` |

## What these reports can't tell you

Stated here because a report that hides its limits is worse than one that has none.

- **No appointment records.** "Consultation booked" is inferred from the lead's *current*
  stage (plus anyone who bought). A lead who booked and was later marked Lost reads as
  lost. Real counts need the calendar work in
  [deferred-todo.md](../deferred-todo.md).
- **One handover per lead.** `Lead.handoverAt` holds the most recent handover only, so a
  lead handed over twice contributes once, and an earlier handover outside the range isn't
  counted at all. Report 3 measures handovers as they stand, not a full event history.
- **No closing date on a quote.** Rejections and withdrawals are dated by the quote's last
  edit (report 8), which is the closing write in practice but not by construction.
- **Nothing marks quotes expired.** Report 8 derives *lapsed* from `expiresAt` having
  passed while the quote is still open. Without that, the quiet losses — usually the
  biggest category — would appear in no loss count at all.
- **Quotes with no owner belong to nobody's row** in report 4. The count and value of those
  are stated under the table rather than dropped, because otherwise every counsellor can
  read as zero while the clinic sold plenty.
- **Cohort vs window.** "Conversion rate" follows the quotes *raised* in the range and asks
  how many converted since — a cohort still deciding, so a recent range always understates
  its eventual rate. "Revenue" counts what *converted* in the range, whenever it was
  raised. Both appear on report 7, deliberately labelled apart.
- **No export.** The tables are read on screen; there's no CSV download yet.
