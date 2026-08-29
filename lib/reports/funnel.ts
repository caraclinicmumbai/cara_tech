// The top of the funnel (§reports 1–3): what came in, how much of it the AI actually
// reached, and how fast a human picked up what the AI handed over.
//
// These three read as one story — leads arrive, the AI works them, the ones it can't
// close go to a counsellor — so they share a range and are computed the same way.

import { prisma } from "@/lib/prisma";
import { slaHours } from "@/lib/handoverSla";
import {
  AI_CALL_TYPES,
  REACHED_OUTCOMES,
  sourceLabel,
  rate,
  mean,
  median,
} from "@/lib/reports/shared";
import { istDay, daysBetween, within, previousRange, type DateRange } from "@/lib/reports/range";

// ── 1. Lead Inflow — how many, from where ────────────────────────────

export type InflowRow = {
  key: string;
  label: string;
  count: number;
  sharePct: number | null;
};

export type InflowReport = {
  total: number;
  /// The same-length window immediately before, so "is this month better" has an answer.
  previousTotal: number;
  changePct: number | null;
  perDay: number | null;
  bySource: InflowRow[];
  byCampaign: InflowRow[];
  byBranch: InflowRow[];
  byDay: { day: string; count: number }[];
  /// Quality flags on the intake itself, not the volume.
  duplicates: number;
  heldForReview: number;
  optedOut: number;
};

function tally(
  rows: { key: string; label: string }[],
  total: number,
  limit?: number,
): InflowRow[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    const cur = counts.get(r.key);
    if (cur) cur.count += 1;
    else counts.set(r.key, { label: r.label, count: 1 });
  }
  const out = [...counts.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count, sharePct: rate(v.count, total) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return limit ? out.slice(0, limit) : out;
}

export async function leadInflow(range: DateRange): Promise<InflowReport> {
  const prev = previousRange(range);
  const [leads, previousTotal, branches] = await Promise.all([
    prisma.lead.findMany({
      where: { createdAt: within(range), deletedAt: null },
      select: {
        createdAt: true,
        source: true,
        campaign: true,
        branchId: true,
        duplicateOfId: true,
        heldForReview: true,
        optedOut: true,
      },
    }),
    prisma.lead.count({ where: { createdAt: within(prev), deletedAt: null } }),
    prisma.branch.findMany({ select: { id: true, name: true } }),
  ]);

  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const total = leads.length;

  // Every day in the range appears, including the empty ones — a gap in the chart is
  // itself the finding (a form that broke, a campaign that stopped).
  const dayCounts = new Map<string, number>();
  for (const l of leads) {
    const d = istDay(l.createdAt);
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const byDay = daysBetween(range.fromDay, range.toDay).map((day) => ({
    day,
    count: dayCounts.get(day) ?? 0,
  }));

  return {
    total,
    previousTotal,
    changePct: previousTotal > 0 ? ((total - previousTotal) / previousTotal) * 100 : null,
    perDay: range.days > 0 ? total / range.days : null,
    bySource: tally(
      leads.map((l) => ({ key: l.source ?? "unknown", label: sourceLabel(l.source) })),
      total,
    ),
    byCampaign: tally(
      leads.filter((l) => l.campaign).map((l) => ({ key: l.campaign!, label: l.campaign! })),
      total,
      12,
    ),
    byBranch: tally(
      leads.map((l) => ({
        key: l.branchId ?? "none",
        label: l.branchId ? (branchName.get(l.branchId) ?? "Unknown branch") : "No branch set",
      })),
      total,
    ),
    byDay,
    duplicates: leads.filter((l) => l.duplicateOfId).length,
    heldForReview: leads.filter((l) => l.heldForReview).length,
    optedOut: leads.filter((l) => l.optedOut).length,
  };
}

// ── 2. AI Contact Rate — how many the AI actually reached ────────────

export type AiContactReport = {
  /// Call-level: every AI call placed in the range.
  attempts: number;
  reached: number;
  noAnswer: number;
  /// Calls with no outcome written back — attempted, but we can't say what happened.
  unknownOutcome: number;
  callContactRatePct: number | null;
  /// Lead-level: of the people the AI tried, how many did it get through to at all.
  leadsAttempted: number;
  leadsReached: number;
  leadContactRatePct: number | null;
  neverReached: number;
  /// How many tries it takes, among the leads it did reach.
  avgAttemptsToReach: number | null;
  /// Talk time on connected calls only — an unanswered call's 0s would halve it.
  avgTalkSeconds: number | null;
  byOutcome: { key: string; label: string; count: number; sharePct: number | null }[];
  byCallType: { key: string; label: string; attempts: number; reached: number; ratePct: number | null }[];
  byDay: { day: string; attempts: number; reached: number }[];
};

const OUTCOME_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  rescheduled: "Rescheduled",
  not_interested: "Not interested",
  no_answer: "No answer",
  unknown: "No outcome recorded",
};

const CALL_TYPE_LABELS: Record<string, string> = {
  initial: "First attempt",
  reconfirmation: "Reconfirmation",
};

export async function aiContactRate(range: DateRange): Promise<AiContactReport> {
  const calls = await prisma.call.findMany({
    where: { createdAt: within(range), callType: { in: AI_CALL_TYPES } },
    select: { leadId: true, callType: true, outcome: true, duration: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const isReached = (o: string | null) => !!o && REACHED_OUTCOMES.includes(o);

  const attempts = calls.length;
  const reached = calls.filter((c) => isReached(c.outcome)).length;
  const noAnswer = calls.filter((c) => c.outcome === "no_answer").length;
  const unknownOutcome = calls.filter((c) => !c.outcome).length;

  // Per lead: how many attempts, and which attempt (if any) got through.
  const perLead = new Map<string, { attempts: number; reachedAt: number | null }>();
  for (const c of calls) {
    const cur = perLead.get(c.leadId) ?? { attempts: 0, reachedAt: null };
    cur.attempts += 1;
    if (cur.reachedAt == null && isReached(c.outcome)) cur.reachedAt = cur.attempts;
    perLead.set(c.leadId, cur);
  }
  const leadsAttempted = perLead.size;
  const reachedLeads = [...perLead.values()].filter((v) => v.reachedAt != null);

  const talkTimes = calls
    .filter((c) => isReached(c.outcome) && c.duration != null && c.duration > 0)
    .map((c) => c.duration!);

  const outcomeCounts = new Map<string, number>();
  for (const c of calls) {
    const k = c.outcome ?? "unknown";
    outcomeCounts.set(k, (outcomeCounts.get(k) ?? 0) + 1);
  }

  const byCallType = AI_CALL_TYPES.map((t) => {
    const subset = calls.filter((c) => c.callType === t);
    const got = subset.filter((c) => isReached(c.outcome)).length;
    return {
      key: t,
      label: CALL_TYPE_LABELS[t] ?? t,
      attempts: subset.length,
      reached: got,
      ratePct: rate(got, subset.length),
    };
  }).filter((r) => r.attempts > 0);

  const dayMap = new Map<string, { attempts: number; reached: number }>();
  for (const c of calls) {
    const d = istDay(c.createdAt);
    const cur = dayMap.get(d) ?? { attempts: 0, reached: 0 };
    cur.attempts += 1;
    if (isReached(c.outcome)) cur.reached += 1;
    dayMap.set(d, cur);
  }

  return {
    attempts,
    reached,
    noAnswer,
    unknownOutcome,
    callContactRatePct: rate(reached, attempts),
    leadsAttempted,
    leadsReached: reachedLeads.length,
    leadContactRatePct: rate(reachedLeads.length, leadsAttempted),
    neverReached: leadsAttempted - reachedLeads.length,
    avgAttemptsToReach: mean(reachedLeads.map((v) => v.reachedAt!)),
    avgTalkSeconds: mean(talkTimes),
    byOutcome: [...outcomeCounts.entries()]
      .map(([key, count]) => ({
        key,
        label: OUTCOME_LABELS[key] ?? key,
        count,
        sharePct: rate(count, attempts),
      }))
      .sort((a, b) => b.count - a.count),
    byCallType,
    byDay: daysBetween(range.fromDay, range.toDay).map((day) => ({
      day,
      attempts: dayMap.get(day)?.attempts ?? 0,
      reached: dayMap.get(day)?.reached ?? 0,
    })),
  };
}

// ── 3. Human Handoff Speed — how fast counsellors picked up ──────────

export type HandoffRow = {
  leadId: string;
  leadName: string;
  repName: string;
  handoverAt: Date;
  firstTouchAt: Date | null;
  waitMs: number | null;
  /// How they picked it up — a logged call or a typed WhatsApp message.
  channel: "call" | "whatsapp" | null;
  reason: string | null;
};

export type HandoffReport = {
  slaHours: number;
  handovers: number;
  pickedUp: number;
  stillWaiting: number;
  medianMs: number | null;
  meanMs: number | null;
  withinSlaPct: number | null;
  buckets: { label: string; count: number }[];
  byRep: {
    repName: string;
    handovers: number;
    pickedUp: number;
    medianMs: number | null;
    withinSla: number;
  }[];
  /// The ones that took longest — the list a manager actually acts on.
  slowest: HandoffRow[];
  /// Handed over and never touched, oldest first.
  waiting: HandoffRow[];
};

const BUCKETS: { label: string; maxMs: number }[] = [
  { label: "Under 15 min", maxMs: 15 * 60_000 },
  { label: "15–60 min", maxMs: 60 * 60_000 },
  { label: "1–2 h", maxMs: 2 * 3_600_000 },
  { label: "2–4 h", maxMs: 4 * 3_600_000 },
  { label: "4–24 h", maxMs: 24 * 3_600_000 },
  { label: "Over 24 h", maxMs: Infinity },
];

/// Handovers that FIRED in the range, and how long each waited for a human.
///
/// A caveat that shapes how this is read: a lead carries ONE `handoverAt` — its most
/// recent handover. A lead handed over twice contributes its latest handover only, and
/// if that latest one falls outside the range the earlier one isn't counted at all. It
/// measures handovers-as-they-stand rather than a full event history.
///
/// "Picked up" means a logged human action: a call recorded against the lead (the
/// in-app Call & record button, or a Twilio click-to-call), or a counsellor-typed
/// WhatsApp message. A rep who dials from their own handset leaves no trace and reads
/// here as never picked up — the same blind spot the SLA escalation has.
export async function handoffSpeed(range: DateRange, now: Date = new Date()): Promise<HandoffReport> {
  const sla = slaHours();
  const leads = await prisma.lead.findMany({
    where: { handoverAt: within(range), deletedAt: null },
    select: {
      id: true,
      name: true,
      handoverAt: true,
      handoverReason: true,
      assignedRep: { select: { name: true } },
    },
    orderBy: { handoverAt: "asc" },
  });

  if (leads.length === 0) {
    return {
      slaHours: sla,
      handovers: 0,
      pickedUp: 0,
      stillWaiting: 0,
      medianMs: null,
      meanMs: null,
      withinSlaPct: null,
      buckets: BUCKETS.map((b) => ({ label: b.label, count: 0 })),
      byRep: [],
      slowest: [],
      waiting: [],
    };
  }

  const leadIds = leads.map((l) => l.id);
  const earliest = leads[0].handoverAt!;

  const [calls, messages] = await Promise.all([
    // A human-placed call: the handover call type, or any call attributed to a rep.
    prisma.call.findMany({
      where: {
        leadId: { in: leadIds },
        createdAt: { gte: earliest },
        OR: [{ callType: "human_handover" }, { handledById: { not: null } }],
      },
      select: { leadId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // A counsellor-typed WhatsApp message (automated campaign sends don't count as
    // someone picking the lead up).
    prisma.message.findMany({
      where: {
        leadId: { in: leadIds },
        createdAt: { gte: earliest },
        direction: "outbound",
        automated: false,
      },
      select: { leadId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Both lists arrive in ascending time order, so the first entry past the handover is
  // the first human touch.
  const groupByLead = (rows: { leadId: string; createdAt: Date }[]) => {
    const out = new Map<string, Date[]>();
    for (const r of rows) {
      const list = out.get(r.leadId);
      if (list) list.push(r.createdAt);
      else out.set(r.leadId, [r.createdAt]);
    }
    return out;
  };
  const callsByLead = groupByLead(calls);
  const messagesByLead = groupByLead(messages);

  const rows: HandoffRow[] = leads.map((l) => {
    const at = l.handoverAt!;
    const call = (callsByLead.get(l.id) ?? []).find((d) => d.getTime() > at.getTime()) ?? null;
    const msg = (messagesByLead.get(l.id) ?? []).find((d) => d.getTime() > at.getTime()) ?? null;
    let firstTouchAt: Date | null = null;
    let channel: "call" | "whatsapp" | null = null;
    if (call && msg) {
      firstTouchAt = call <= msg ? call : msg;
      channel = call <= msg ? "call" : "whatsapp";
    } else if (call) {
      firstTouchAt = call;
      channel = "call";
    } else if (msg) {
      firstTouchAt = msg;
      channel = "whatsapp";
    }
    return {
      leadId: l.id,
      leadName: l.name,
      repName: l.assignedRep?.name ?? "Unassigned",
      handoverAt: at,
      firstTouchAt,
      waitMs: firstTouchAt ? firstTouchAt.getTime() - at.getTime() : null,
      channel,
      reason: l.handoverReason,
    };
  });

  const answered = rows.filter((r) => r.waitMs != null);
  const waits = answered.map((r) => r.waitMs!);
  const slaMs = sla * 3_600_000;

  const buckets = BUCKETS.map((b, i) => {
    const lower = i === 0 ? -1 : BUCKETS[i - 1].maxMs;
    return { label: b.label, count: waits.filter((w) => w > lower && w <= b.maxMs).length };
  });

  const repNames = [...new Set(rows.map((r) => r.repName))];
  const byRep = repNames
    .map((repName) => {
      const mine = rows.filter((r) => r.repName === repName);
      const mineAnswered = mine.filter((r) => r.waitMs != null);
      return {
        repName,
        handovers: mine.length,
        pickedUp: mineAnswered.length,
        medianMs: median(mineAnswered.map((r) => r.waitMs!)),
        withinSla: mineAnswered.filter((r) => r.waitMs! <= slaMs).length,
      };
    })
    .sort((a, b) => b.handovers - a.handovers);

  return {
    slaHours: sla,
    handovers: rows.length,
    pickedUp: answered.length,
    stillWaiting: rows.length - answered.length,
    medianMs: median(waits),
    meanMs: mean(waits),
    // Out of ALL handovers, not just the answered ones: a handover nobody ever touched
    // is the worst possible SLA outcome and must not drop out of the denominator.
    withinSlaPct: rate(answered.filter((r) => r.waitMs! <= slaMs).length, rows.length),
    buckets,
    byRep,
    slowest: [...answered].sort((a, b) => b.waitMs! - a.waitMs!).slice(0, 10),
    waiting: rows
      .filter((r) => r.waitMs == null)
      .sort((a, b) => a.handoverAt.getTime() - b.handoverAt.getTime())
      .slice(0, 10)
      .map((r) => ({ ...r, waitMs: now.getTime() - r.handoverAt.getTime() })),
  };
}
