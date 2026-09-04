# Software subscriptions & accounts

Every third-party service Cara depends on, what it does, what breaks without it, and
where the money goes.

**Status of this document.** Everything under *Verified* was read live from each provider's
API on **3 September 2026** — account status, plan tier, balances, renewal dates, numbers
owned, and **every cost figure the providers will actually surrender**. Twilio gives up its
real monthly spend and per-minute rates, so those are filled in below; ElevenLabs gives its
next payment date and amount due.

What is still blank is what is genuinely locked behind a login: **five providers expose no
billing data to an API at all** (Railway, Slack, n8n, GitHub's owner plan, and Meta's
conversation spend), and Anthropic's cost report needs an Admin key this system doesn't
hold. Each of those now names the exact screen to read it from. Nothing here is estimated —
an invented figure in a cost document is worse than an empty field.

> **Re-run the verified half any time:** `./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/preflight.ts`

---

## At a glance

| # | Service | What it does | Without it | Billing model |
|---|---------|--------------|-----------|----------------|
| 1 | **Railway** | Hosts the CRM: web, worker, Postgres, Redis | Everything stops | Usage (per service/hour + storage) |
| 2 | **Twilio** | Counsellor click-to-call, call recording, inbound clinic line | No human calling | Prepaid balance + per-number/month + per-minute |
| 3 | **ElevenLabs** | The AI voice agent ("Manish") and call transcription | No AI calls, no transcripts, CQS stops | Monthly plan (character quota) |
| 4 | **Meta — WhatsApp Business** | Every patient WhatsApp message | No WhatsApp at all | Per-conversation, post-paid |
| 5 | **Meta — Lead Ads** | Facebook/Instagram lead capture | Those leads stop arriving | Free API (ad spend is separate) |
| 6 | **Anthropic (Claude API)** | Call-quality scoring (CQS) | Calls stop being scored | Usage (per token) |
| 7 | **Slack** | Staff alerts: handovers, SLA breaches, health, reminders | Alerts fall back to in-app only | Per active user, or free tier |
| 8 | **n8n Cloud** | Workflow automation between CRM and ElevenLabs | AI call triggering stops | Monthly plan (per execution) |
| 9 | **GitHub** | Source code, deploy trigger | No deploys | Free or per seat |
| 10 | **Google Ads lead forms** | Google lead capture | Those leads stop arriving | Free API (ad spend is separate) |

**Not yet subscribed, but needed** — see [Gaps](#gaps-things-not-yet-paid-for) at the end.

---

## 1. Railway — hosting

Runs four billable components: the **web** app, the **worker** (all the background jobs:
AI call attempts, SLA checks, follow-up reminders, health monitor, daily digest), plus
managed **Postgres** and **Redis**.

**Verified:** production is live and answering at
`https://caratech-production.up.railway.app` (HTTP 200). Deploys are triggered by a push
to `main` on GitHub — both web and worker rebuild.

> ⚠️ **The worker is not optional.** Follow-up reminders, AI retries, the daily digest and
> the health monitor all live there, not in the web app. If the worker service is stopped
> or crash-looping, the CRM looks fine and quietly stops doing anything on a timer.

**Still to complete** — no Railway API token is configured, so nothing here is readable
automatically: plan/tier · monthly cost · billing date · payment method · account owner ·
whether Postgres and Redis are billed separately · whether there's a custom domain. All at
**railway.app → Project → Settings → Usage**.

---

## 2. Twilio — telephony

Counsellor click-to-call (the "Call & record" button), call recording, the whisper that
discloses recording to the patient, and inbound routing from the clinic number.

**Verified 3 Sep 2026** — spend read from Twilio's usage records, rates from its pricing API:

| | |
|---|---|
| Account | **CARA Clinic** — type **Full** (not trial), status **active** |
| Opened | 23 April 2025 |
| Balance | **USD 16.32** — prepaid, so there is no renewal date; it runs out instead |
| Numbers owned | **1** — `+1 810 428 0484`, voice + SMS, held since 7 June 2026 |
| **Verified caller IDs** | **2 Indian numbers** — `+91 77100 70566` (23 Apr 2025) and `+91 95361 08238` (7 Jun 2026) |
| **Caller ID in use** | **`+91 77100 70566`** as of 4 Sep 2026 — *locally; still `+1` in production until Railway is updated* |
| **Number rental** | **USD 1.15 / month** |
| **Outbound to India (mobile)** | **USD 0.05 / minute** |
| **Spend — Jun 2026** | USD 5.89 |
| **Spend — Jul 2026** | USD 13.94 |
| **Spend — Aug 2026** | USD 1.76 |
| **Spend — Sep 2026** (to 3rd) | USD 0.22 |
| **All-time spend** | **USD 21.82** since 23 April 2025 |

> ℹ️ **Run-rate vs balance.** July cost USD 13.94; August only USD 1.76. At July's rate the
> USD 16.32 balance is roughly **five weeks**; at August's, closer to nine months. Call
> volume, not a fixed subscription, is what decides — so the balance needs watching in a
> month when calling ramps up, not on a calendar.

> 🟠 **The caller ID has moved to an Indian number — but it is unproven.** No purchase was
> needed; two Indian numbers were already verified on the account. **Still to do:** set it
> on Railway, then place one real test call and look at the handset. India's DoT directs
> carriers to block incoming international calls displaying an Indian CLI (the signature
> of spoofed scam calls), and a Twilio call from outside India showing `+91` fits that
> description. See [deferred-todo.md](deferred-todo.md).

> ⚠️ **A prepaid balance has no invoice to remind you.** At USD 16.32 this is small; when
> it hits zero, calling stops dead. The account was suspended for non-payment once before
> (Aug 2026), which surfaced as "Twilio API down" alerts. Worth an auto-recharge.

**Still to complete** (not exposed by the API): whether auto-recharge is on, and at what
threshold — Twilio Console → **Billing → Auto-recharge** · billing contact / card owner.

---

## 3. ElevenLabs — AI voice + transcription

The outbound AI agent (**"Manish"**, verified reachable) and Scribe transcription of
human-handover call recordings.

**Verified 2 Sep 2026:**

| | |
|---|---|
| Plan | **Creator**, status **active**, billed **monthly**, currency **INR** |
| Quota | **121,028 characters** per period · **4,015 used (3%)** |
| Period resets | **30 September 2026** |
| Overflow | **Disabled** — the quota is a hard stop, not an overage charge |
| Voice slots | 30 |
| **Next payment attempt** | **30 September 2026** — same day the quota resets |
| **Next invoice — amount due** | **INR 0.00** |
| **Open invoices** | **None** |

> ℹ️ **An active paid plan showing INR 0.00 due** usually means credit, an annual payment
> already made, or a discount on the account — the API reports the figure, not the reason.
> Worth confirming against the invoice, because it changes what happens on 30 September.

> ⚠️ **Overflow is off, which is a deliberate spending cap but also a cliff.** This account
> hit **100% of quota on 30 August 2026** and AI calling stopped completely until reset.
> The worker warns on Slack at 90% (`ELEVENLABS_LOW_CREDIT_PCT`). Decide which you want:
> a hard stop, or overflow enabled with a budget.

**Still to complete:** the plan's headline monthly price (the API gives the amount *due*,
not the list price) · whether an annual plan is cheaper · who holds the login. All at
**elevenlabs.io → Subscription**.

---

## 4. Meta — WhatsApp Business Platform (Cloud API)

Every patient WhatsApp message: templates, the live chat thread, quote PDFs, campaign
sends, post-sales check-ins.

**Verified 2 Sep 2026:**

| | |
|---|---|
| WABA | **Cara Clinic** — review status **APPROVED** |
| Currency | **INR** |
| Number | **+91 77100 80652** ("Cara Clinic") — status **CONNECTED**, quality **GREEN** |
| Templates | **5 approved** |

Charged **per conversation** (24-hour windows), not per message, at Indian rates that
differ by category — marketing, utility, authentication, service. Post-paid against a
payment method on the Meta business account.

> ℹ️ **Quality rating is GREEN and worth protecting.** It drops if patients block or report
> the number; a low rating cuts the daily messaging limit, and a further drop can suspend
> the number. The follow-up campaigns are the main volume risk here.

> ⚠️ **Conversation spend could not be read.** Meta's `conversation_analytics` endpoint
> returns **zero data points** over 90 days, while the CRM's own records show 17 outbound
> and 2 inbound messages in that window — so this is a permission or reporting gap, **not**
> evidence that nothing was billed. Don't read it as "WhatsApp is free"; read it from
> Meta Billing.

**Still to complete:** monthly conversation spend — **business.facebook.com → Billing &
Payments → WhatsApp** · billing date · payment method on the Meta business account ·
messaging tier (limit per 24h) · who administers the Business Manager.

---

## 5. Meta — Lead Ads (Facebook / Instagram)

Lead-form submissions flow straight into the CRM. **The API itself is free** — what costs
money is the ad spend, which is a marketing budget rather than a software subscription
(see [Ad spend](#ad-spend-not-a-subscription-but-it-is-a-cost)).

> ⚠️ **Auto-calling of Meta leads is paused**, pending Meta App Review of `leads_retrieval`
> advanced access. Leads are captured but not automatically called.

**To complete:** which Business Manager owns the app · App Review status.

---

## 6. Anthropic (Claude API) — call quality scoring

Scores every AI call 0–100 (CQS) with a per-dimension breakdown, which drives handover
triggers and the Sales Head's alerts on exceptional and failed calls.

**Verified 2 Sep 2026:** API key **valid**, 11 models visible. Model configured via
`CQS_MODEL`.

Billed by usage (per token). **Spend is not exposed by the API** — read it from
`console.anthropic.com`.

> ⚠️ **Spend needs an Admin key.** Anthropic's cost and usage reports rejected the CRM's
> key: *"The Admin API requires an Admin API key or an organization-scoped API key."* The
> figure exists, but not to this credential.

**Still to complete:** current spend and any budget cap — **console.anthropic.com →
Usage / Cost** (or issue an Admin API key there if you want it read automatically) ·
prepaid credits or monthly invoice · billing date.

---

## 7. Slack — staff alerts

Handover alerts, the 2-hour SLA escalation, stuck-in-stage warnings, the daily digest,
system-health alarms, and follow-up reminders.

**Verified 2 Sep 2026:** connected — workspace **Cara CRM**, bot user `cara_crm`,
messages deliver to the default channel.

> ℹ️ **The plan could not be read** — the bot token lacks the `team:read` scope. Free vs Pro
> matters here: the free tier hides messages older than 90 days, so alert history
> disappears.

> ⚠️ **DMs need real member IDs.** `SalesRep.slackUserId` currently holds `"rohit"` for one
> counsellor — a handle, not a Slack member ID (`U…`). Alerts aimed at that person were
> being dropped silently until this was fixed on 3 Sep; they now fall back to the shared
> channel. To get true DMs: Slack → click the person → **View full profile** → **More** →
> **Copy member ID**, then paste it onto the rep.

**Still to complete** — the bot token lacks `team:read`, so none of this is readable from
here: plan (Free / Pro / Business+) · paid seats · cost/month · billing date. All at
**slack.com/admin/billing**.

---

## 8. n8n Cloud — workflow automation

Hosted at **`caraclinic.app.n8n.cloud`**. Sits between the CRM and ElevenLabs: the CRM
fires a "new lead" webhook, n8n formats it and asks ElevenLabs to place the call.

**Still to complete** — `N8N_API_KEY` isn't set in this environment, and n8n's public API
exposes workflows and executions but **no billing endpoint at all**, so this can only come
from the portal: plan · monthly cost · billing date · execution quota and usage · workspace
owner. All at **caraclinic.app.n8n.cloud → Settings → Usage and plan**.

---

## 9. GitHub — source code

Repository **`caraclinicmumbai/cara_tech`**. A push to `main` triggers the Railway deploy.

> 🔴 **The repository is still PUBLIC.** Verified against the GitHub API on 3 Sep 2026:
> `"visibility": "public"`. An earlier version of this document said it had been made
> private on 3 September — that was an assumption, not a check, and it was wrong.
> Changing visibility is owner-only: sign in as `caraclinicmumbai` →
> `github.com/caraclinicmumbai/cara_tech/settings` → **Danger Zone → Change visibility**.

**Verified:** no credentials were ever committed across all 251 commits — only a
placeholder `.env.example`. So what is exposed is source code and documentation, not
access to anything. That is a reason to fix it calmly rather than urgently, but it is
still worth fixing.

> ℹ️ Owned by the personal account `caraclinicmumbai`, not an organisation. The
> `Faharimran` account has push access but **not admin**, which is why visibility had to be
> changed by the owner.

**Still to complete** — the signed-in account (`Faharimran`) is a collaborator, not the
owner, so the owner's plan isn't visible to it: plan (Free / Team) · cost · who else has
access. **github.com/settings/billing** as `caraclinicmumbai`.

---

## 10. Google Ads lead forms

Lead-form submissions post into the CRM. **Free API**; the cost is ad spend.

**To complete:** which Google Ads account · who administers it.

---

## Ad spend — not a subscription, but it is a cost

Meta and Google advertising is the largest recurring cost in this stack and the one the
Source Attribution report exists to justify. It is **not** currently imported.

Until a daily import runs, every cost-per-lead, cost-per-consultation and cost-per-surgery
figure in `/reports` reads **"unavailable"** — deliberately, because counting a missing day
as ₹0 would make whichever channel was forgotten look like the cheapest one.

Two ways to feed it in (both idempotent, re-importing a day replaces it):

```bash
# CSV export from Meta/Google Ads
./node_modules/.bin/dotenv -e .env.local -- npx tsx scripts/importAdSpend.ts spend.csv --apply --zero-fill
```
```http
POST /api/webhooks/ad-spend    x-webhook-secret: <WEBHOOK_SECRET>
{ "entries": [ { "day": "2026-09-01", "source": "facebook", "amount": 12500 } ] }
```

**To complete:** monthly Meta ad budget · monthly Google Ads budget · who sets them.

---

## Gaps — things not yet paid for

| Need | Why | Priority |
|---|---|---|
| **Indian caller ID or Indian telephony provider** | Patients don't answer the US number. Verifying an Indian number you own as a Twilio caller ID may be free; an Indian provider (Exotel / Knowlarity / Ozonetel) is a subscription | 🔴 Blocks calling |
| **Truecaller Business listing** | Whichever number ends up dialling should be verified, or it gets flagged on reputation alone | 🔴 Pairs with the above |
| **Email provider** | The International Patient campaign is WhatsApp + email; no email provider is wired up, so that campaign has no steps | 🟠 Blocks one campaign |
| **Meta App Review** (`leads_retrieval`) | Until approved, Facebook/Instagram leads are captured but never auto-called | 🟠 No cost, needs submission |
| **Uptime monitoring** (external) | The health monitor runs *inside* the worker, so it cannot detect the worker being down | 🟠 Cheap insurance |

---

## Things to check on a schedule

| When | Check |
|---|---|
| **Weekly** | Twilio balance · ElevenLabs quota % · WhatsApp quality rating |
| **Monthly** | Every invoice against this document · ad spend imported for every day |
| **Before a demo** | `scripts/preflight.ts` — it checks all of the above in one pass |
| **On renewal** | Whether the plan still fits: ElevenLabs characters, n8n executions, Slack seats |

---

## What this document cannot tell you

To be explicit, since this is a cost document:

- **No prices, billing dates or payment methods** are stated anywhere above. They are in
  each provider's billing portal, which the CRM has no access to and no credentials for.
- **Account ownership** — who the invoices go to and whose card is on file — is unknown
  to the system.
- **Slack's plan** could not be read (missing API scope).
- **Anthropic's spend** is not exposed by their API.
- Everything marked *Verified* was read live from the provider on **3 September 2026** and
  can be re-checked with `scripts/preflight.ts`.

_Last verified: 3 September 2026._
