# 08 — Follow-up campaigns (§follow-up)

Phase 2's biggest revenue item: leads that ignore the AI calls + first WhatsApp no longer
vanish. They enter an automated follow-up **campaign** — and a set of hard guardrails keep
that from ever becoming harassment.

> **Stage 1** shipped the **engine + all four guardrails + per-branch controls +** the
> "Couldn't Reach Them" campaign. **Stage 2** adds the two WhatsApp nurture drips
> (Worried About Cost, Just Researching) and **automatic enrollment** from the AI call.
> The remaining three campaigns are declared but stepless — later stages.

## The seven campaigns

| Key | Name | Status |
|-----|------|--------|
| `couldnt_reach` | Couldn't Reach Them — messages days 1/5/14/30, then **Lost** | ✅ Stage 1 |
| `worried_cost` | Worried About Cost (days 1/3/7/14) | ✅ Stage 2 |
| `just_researching` | Just Researching (weekly, max 6) | ✅ Stage 2 |
| `hot_lead` | Hot Lead — Fast Track (counsellor call ≤2h; routing, not messaging) | declared |
| `international` | International Patient (WhatsApp + email) | declared |
| `win_back` | Win-Back (90d after Lost, max 4/yr) | declared |
| `dead_lead_bulk` | Dead Lead Bulk (Sales-Head-approved batch) | declared |

Definitions live in [lib/campaigns/types.ts](../../lib/campaigns/types.ts) as data (a schedule
of WhatsApp template steps + an optional terminal action). The engine is campaign-agnostic.

## The guardrails (the hard part)

Every send passes through `checkEligibility()` ([lib/campaigns/eligibility.ts](../../lib/campaigns/eligibility.ts))
in this order — the first failure wins:

1. **Hard exclusions** — `possibleMinor` / `legalThreatFreeze` / `complaintOpen` (or a
   soft-deleted lead). **No per-branch toggle can override these.** → the enrollment is **stopped**.
2. **Opt-out** — the `optedOut` hard suppression. → **stopped**.
3. **Reply-stops-everything** — any inbound message since the campaign started means a human
   is now in the conversation; the system must never talk over them. → **stopped**. Enforced
   both live at the WhatsApp webhook and re-checked in the gate.
4. **The 12-in-30 ceiling** — **max 12 automated messages to a PERSON in 30 days**, across
   all campaigns, all quotes, all channels (counts `Message` rows with `automated=true`). → **deferred**.
5. **Branch quiet hours** — no campaign message inside the branch's quiet window (default
   **20:00–09:00 IST**; [lib/campaigns/quietHours.ts](../../lib/campaigns/quietHours.ts)). → **deferred**.
6. **Per-branch on/off toggle** — campaign disabled for the branch. → **paused** (reversible;
   re-checked later, unlike a stop).

### One campaign per person — never per quote

Enforced by the **database**: a partial unique index `("leadId") WHERE status = 'active'` on
`CampaignEnrollment` makes a second active enrollment structurally impossible. When two quotes
are open, the higher-value / sooner-expiring one **selects** the campaign (recorded as
`drivingQuoteId`, context only) — but the enrollment, the ceiling, and every guardrail hang
off the **person**.

## How a lead enters — automatic classification (Stage 2)

Leads are sorted into a campaign by **how the AI call went**, never by hand. After every
recorded call, [lib/callIntake.ts](../../lib/callIntake.ts) calls `classifyFromCall()`
([lib/campaigns/classify.ts](../../lib/campaigns/classify.ts)) with the call's signals and
`enrollLead()`s the result (self-guarded, so a null result or an already-enrolled lead is a
safe no-op). The rules, in order (user-approved: **handover always wins**):

1. **Unreachable** after the full call ladder → `couldnt_reach`.
2. A retry call still pending, opt-out, **handover fired**, confirmed booking, or a scheduled
   callback → **no campaign** (a stronger path owns the lead).
3. Otherwise, a call we actually answered:
   - a **cost/financing signal** in the tag or handover reasons (price / EMI / budget /
     financing …) → `worried_cost`;
   - `interestLevel = high` but no handover → **no campaign** (left for a human);
   - anything else warm-but-browsing → `just_researching`.

Handover always wins because a handed-over lead is already with a human — the drip must not
talk over them (same principle as the reply-stop guardrail).

## The engine loop

`runCampaignTick()` ([lib/campaigns/engine.ts](../../lib/campaigns/engine.ts)) runs on a worker
interval (`CAMPAIGN_TICK_MINUTES`, default 15). Each due enrollment: run the gate → send the
current step's approved template → schedule the next step (`nextRunAt`) or **complete** and
run the terminal action (Couldn't Reach → mark **Lost**, premature-loss aware). Deferrals just
push `nextRunAt` forward — no separate delayed jobs — so the guardrails re-evaluate every attempt.

## Controls

- **Global kill-switch**: `CAMPAIGNS_ENABLED` (env). **OFF by default** — nothing enrols or
  sends until it's truthy, so deploying the code can't message anyone by surprise.
- **Per-branch**: quiet hours + a per-campaign on/off switch, both on the **Branches** admin
  screen (`branches.manage`, audited: `settings.campaign.toggle`).
- **Step templates**: `WHATSAPP_TEMPLATE_CR_DAY1/5/14/30` (approved WhatsApp templates; unset
  = that step is a safe no-op, schedule still advances).

## Data model

- `CampaignEnrollment` — a lead's membership (status, step, `nextRunAt`, `drivingQuoteId`,
  `messagesSent`, stop reason). Partial-unique on active `leadId`.
- `CampaignSetting` — per-branch `(branchId, campaignType) → enabled`; absence = enabled.
- `Branch.quietStartHour` / `quietEndHour` — IST hours; null = default 20:00–09:00.

## Audit

`lead.campaign.enroll` / `lead.campaign.stop` / `lead.campaign.complete` on the lead;
`lead.stage.move` when a campaign marks a lead Lost; `settings.campaign.toggle` for branch switches.

## Not yet (later stages)

Hot-Lead fast-track routing wiring · email provider (International Patient) · Win-Back review
queue + 90-day auto + annual cap · Dead-Lead-Bulk approval UI.
