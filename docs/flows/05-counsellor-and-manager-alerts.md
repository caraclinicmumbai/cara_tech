# Flow 5 — Counsellor & manager alerts

Three oversight feeds: a real-time **counsellor** feed for events that need attention,
a **sales-head** feed reserved for CQS extremes, and a once-a-day **branch manager**
digest.

## Counsellor oversight feed (`lib/counsellor.ts`)

A single Slack feed (`notifyCounsellor`) to the counsellor/supervisor for five event
kinds. Target = `COUNSELLOR_CHANNEL` → `HANDOVER_ESCALATION_CHANNEL` →
`SLACK_DEFAULT_CHANNEL`.

| Kind | Fires when | Where |
|------|------------|-------|
| `ai_handoff` | An AI call hands a lead to sales (generic) | `recordCall` handover branch |
| `fast_track` | The handover was driven by CQS ≥ 75 | same |
| `threat` | The `abusive` trigger fired | same |
| `premature_lost` | A lead is marked **Lost before completing a consultation** | `setLeadStage` |
| `stage_sla` | A lead is **stuck in a stage** past the SLA | worker scan |

**Handover events** send one counsellor copy per handover, framed by the most
significant trigger (threat > fast-track > generic), alongside the per-rep DM (flow 4).

**Premature lost:** when staff mark a lead `lost`, if the lead's current stage is
pre-consultation (`stageRank < consultation_done`), the lead is flagged
`prematureLost = true` and the counsellor is alerted for a possible save. The flag is
cleared if the lead is reactivated.

**Stuck-in-stage SLA (`lib/stageSla.ts`):** the worker scans every
`STAGE_SLA_SCAN_HOURS` for leads whose `stageChangedAt` is older than `STAGE_SLA_DAYS`,
excluding won/terminal stages (`converted_followup`, `converted`, `lost`) and
opted-out leads. Each is alerted **once per stall** (`stageStuckNotifiedAt` dedups;
it's nulled whenever the stage changes, re-arming the next stall).

## Sales-head escalation (`lib/salesHead.ts`)

The **sales head** is a manager, not a line telecaller. A `SalesRep` with
`salesHead = true` is **excluded from the round-robin rota** (`pickNextRep` filters
them out) — so routine handovers never route to them — and is DM'd **only on CQS
extremes**: a call scoring **≥ `SALES_HEAD_CQS_HIGH`** (default 90 — a standout worth
their personal touch) or **≤ `SALES_HEAD_CQS_LOW`** (default 15 — a quality failure
worth review).

`notifySalesHead(lead, cqs)` fires from **both** scoring points, independent of any
handover: the AI post-call path (`recordCall`, every scored AI call) and the human
callback path (`transcribeAndScoreCall`, after a recorded call is scored). It targets
the sales head's own Slack DM (`SalesRep.slackUserId`). Best-effort — no sales head,
no Slack id, or a non-extreme score → no-op.

> Keep `COUNSELLOR_CHANNEL` pointed at a counsellor/ops channel, **not** the sales
> head, or they'll receive the full oversight feed on top of their extremes-only DMs.

## Branch Manager daily digest (`lib/digest.ts`)

Once a day (default 09:00 IST), a BullMQ **repeatable/cron** job posts a summary of
the previous IST calendar day to `BRANCH_MANAGER_CHANNEL`:

- **Leads received** (+ top 3 sources)
- **AI contact rate** — reached ÷ attempted over AI call outcomes (a "reached" call
  logged `confirmed`/`rescheduled`/`not_interested`; `human_handover` calls excluded)
- **Callback pending beyond SLA** — a live snapshot of handovers still unattended past
  `HANDOVER_SLA_HOURS` (mirrors flow 4's "unattended" definition), with names
- **Premature Lost flags** raised that day

## Key files

- `lib/counsellor.ts` — `notifyCounsellor`, `counsellorChannel`, the 5 kinds
- `lib/salesHead.ts` — `notifySalesHead`, `isSalesHeadScore` (CQS-extreme DM)
- `lib/salesReps.ts` — `pickNextRep` (excludes sales heads), `getSalesHead`
- `lib/stageSla.ts` — stuck-in-stage scan
- `lib/digest.ts` — metrics, rendering, cron scheduling
- `lib/leadStages.ts` — `isPreConsultation`, `STAGE_SLA_EXCLUDED`
- `workers/callQueueWorker.ts` — runs the scan + registers/processes the digest cron

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `COUNSELLOR_CHANNEL` | → escalation/default channel | Counsellor feed target (not the sales head) |
| `SALES_HEAD_CQS_HIGH` | `90` | CQS at/above this DMs the sales head |
| `SALES_HEAD_CQS_LOW` | `15` | CQS at/below this DMs the sales head |
| `BRANCH_MANAGER_CHANNEL` | → default channel | Digest target |
| `STAGE_SLA_DAYS` | `7` | Days in a stage before "stuck" |
| `STAGE_SLA_SCAN_HOURS` | `6` | How often the worker scans for stuck leads |
| `DIGEST_HOUR_IST` | `9` | Hour (IST) the digest is sent |

## Limitations

- **Premature-lost only triggers from the manual `setLeadStage` action.** Nothing
  auto-marks a lead `lost`, so an abandoned lead that's never manually closed won't
  raise a premature-lost flag (it would instead surface via stuck-in-stage).
- **AI contact rate is call-attempt-based**, not unique-lead-based — multiple attempts
  on one lead each count toward attempts.
- **The digest window is the previous IST calendar day**; a digest sent late (worker
  down at 09:00) still reports that same prior day when it eventually fires.
- **Stuck-in-stage excludes `existing_followup`? No — it is tracked**; only
  `converted_followup`/`converted`/`lost` are excluded. A long-term follow-up lead will
  be flagged if it sits past the SLA — tune `STAGE_SLA_DAYS` accordingly.
- **All alerts require Slack configured**; with no token/channel they're logged and
  skipped.
