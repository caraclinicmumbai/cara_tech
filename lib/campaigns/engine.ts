// Follow-up campaign engine (Phase 2 §follow-up). Owns enrollment, the per-tick step
// advancement, and stopping. It is deliberately thin: every "may we send?" decision is
// delegated to checkEligibility() (lib/campaigns/eligibility.ts), and every actual send
// goes through sendAutomatedTemplate() (which already handles opt-out + logging + the
// Message row that the 12-in-30 ceiling counts).
//
// Scheduling model: each active enrollment carries `nextRunAt`. A periodic tick (run from
// the worker) picks up all enrollments due now and processes one step each. Deferrals
// (ceiling / quiet hours) just push `nextRunAt` forward — no separate delayed jobs — so
// the guardrails re-evaluate cleanly on every attempt.
import type { CampaignEnrollment, Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { sendAutomatedTemplate, firstName } from "@/lib/outreach";
import { isPreConsultation } from "@/lib/leadStages";
import { CAMPAIGNS, campaignsEnabled, isCampaignType, type CampaignDef, type CampaignType } from "@/lib/campaigns/types";
import { checkEligibility, hardExclusion } from "@/lib/campaigns/eligibility";

const DAY_MS = 24 * 60 * 60 * 1000;

// A paused enrollment (branch toggle off) is re-checked after this long rather than every
// tick, so a toggled-off campaign doesn't spin. It resumes cleanly when the toggle returns.
const PAUSE_BUMP_MS = 60 * 60 * 1000; // 1h

// How many due enrollments to process per tick. Ample headroom for a single-clinic load;
// leftovers are simply picked up on the next tick.
const TICK_BATCH = 200;

// Quote statuses that count as "open" for choosing the driving quote (§follow-up: when two
// quotes are open, the higher-value/urgency one selects the campaign — but the campaign
// still follows the PERSON). Closed/terminal statuses are excluded.
const OPEN_QUOTE_STATUSES = ["drafted", "sent", "viewed", "accepted", "awaiting_payment"];

/// When two+ quotes are open, pick the one that should "drive" the campaign: highest value
/// (totalPayable, else base price), tie-broken by soonest expiry (more urgent). Returns the
/// quote id, or null when the lead has no open quote. Context only — enrollment is per person.
async function selectDrivingQuote(leadId: string): Promise<string | null> {
  const quotes = await prisma.quote.findMany({
    where: { leadId, status: { in: OPEN_QUOTE_STATUSES } },
    select: { id: true, totalPayable: true, price: true, expiresAt: true },
  });
  if (quotes.length === 0) return null;
  const value = (q: (typeof quotes)[number]) => q.totalPayable ?? q.price ?? 0;
  const expiry = (q: (typeof quotes)[number]) => q.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  quotes.sort((a, b) => value(b) - value(a) || expiry(a) - expiry(b));
  return quotes[0]!.id;
}

/// The UTC instant step `index` is due, given when the enrollment started. Null past the end.
function stepDueAt(startedAt: Date, def: CampaignDef, index: number): Date | null {
  const step = def.steps[index];
  if (!step) return null;
  return new Date(startedAt.getTime() + step.dayOffset * DAY_MS);
}

export type EnrollResult =
  | { ok: true; enrollmentId: string }
  | { ok: false; reason: string };

/// Enrol a lead into a campaign. Enforces the guardrails at the door: the global kill-switch,
/// hard exclusions, and opt-out all refuse enrollment; the DB's partial unique index refuses
/// a SECOND active enrollment (one campaign per person, ever) with a P2002 we translate to
/// `already_active`. Safe to call speculatively — it self-guards.
export async function enrollLead(
  leadId: string,
  campaignType: CampaignType,
  opts: { drivingQuoteId?: string | null } = {},
): Promise<EnrollResult> {
  if (!campaignsEnabled()) return { ok: false, reason: "campaigns_disabled" };
  const def = CAMPAIGNS[campaignType];

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, branchId: true, possibleMinor: true, legalThreatFreeze: true, complaintOpen: true, deletedAt: true, optedOut: true },
  });
  if (!lead) return { ok: false, reason: "lead_not_found" };

  const excluded = hardExclusion(lead);
  if (excluded) return { ok: false, reason: `excluded:${excluded}` };
  if (lead.optedOut) return { ok: false, reason: "opted_out" };

  const drivingQuoteId = opts.drivingQuoteId ?? (await selectDrivingQuote(leadId));
  const startedAt = new Date();
  const nextRunAt = stepDueAt(startedAt, def, 0);

  try {
    const created = await prisma.campaignEnrollment.create({
      data: { leadId, campaignType, status: "active", step: 0, branchId: lead.branchId, drivingQuoteId, startedAt, nextRunAt },
      select: { id: true },
    });
    await writeAudit({
      action: "lead.campaign.enroll", entityType: "lead", entityId: leadId,
      newValue: def.label, meta: { campaignType, drivingQuoteId },
    });
    logger.info(`Enrolled lead ${leadId} in campaign "${campaignType}" (enrollment ${created.id})`);
    return { ok: true, enrollmentId: created.id };
  } catch (err) {
    // Partial unique index (one active per lead) → the lead is already in a campaign.
    if ((err as { code?: string }).code === "P2002") return { ok: false, reason: "already_active" };
    throw err;
  }
}

/// Stop a lead's ACTIVE enrollment (if any). The reply-stop hook and opt-out call this.
/// Returns how many were stopped (0 or 1). Best-effort audit.
export async function stopEnrollmentForLead(leadId: string, reason: string): Promise<number> {
  const res = await prisma.campaignEnrollment.updateMany({
    where: { leadId, status: "active" },
    data: { status: "stopped", stoppedAt: new Date(), stopReason: reason, nextRunAt: null },
  });
  if (res.count > 0) {
    await writeAudit({ action: "lead.campaign.stop", entityType: "lead", entityId: leadId, newValue: reason });
    logger.info(`Stopped ${res.count} active campaign enrollment(s) for lead ${leadId} (${reason})`);
  }
  return res.count;
}

/// Move a lead to the Lost stage when a campaign with onComplete="mark_lost" finishes.
/// No-op if the lead is already Lost. Records whether it was a premature (pre-consultation) loss.
async function markLostForCampaign(lead: Lead, def: CampaignDef): Promise<void> {
  if (lead.stage === "lost") return;
  const premature = isPreConsultation(lead.stage);
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      stage: "lost",
      lostAt: new Date(),
      lostReason: def.lostReason ?? "Follow-up campaign completed",
      prematureLost: premature,
      stageChangedAt: new Date(),
      stageStuckNotifiedAt: null,
    },
  });
  await writeAudit({
    action: "lead.stage.move", entityType: "lead", entityId: lead.id,
    field: "stage", oldValue: lead.stage, newValue: "lost", reason: def.lostReason ?? null,
  });
  logger.info(`Lead ${lead.id} marked Lost by campaign "${def.type}"${premature ? " (premature)" : ""}`);
}

async function endEnrollment(id: string, status: "stopped" | "completed", reason: string): Promise<void> {
  await prisma.campaignEnrollment.update({
    where: { id },
    data: { status, stoppedAt: new Date(), stopReason: reason, nextRunAt: null },
  });
}

export type TickStats = { processed: number; sent: number; stopped: number; deferred: number; paused: number; completed: number };

/// Process one due enrollment: gate → send current step → advance (or complete).
async function processEnrollment(enr: CampaignEnrollment, now: Date, stats: TickStats): Promise<void> {
  stats.processed++;

  const lead = await prisma.lead.findUnique({ where: { id: enr.leadId } });
  if (!lead) {
    await endEnrollment(enr.id, "stopped", "lead_gone");
    stats.stopped++;
    return;
  }

  // Unknown campaign type (e.g. a renamed/removed campaign) — stop rather than crash-loop.
  if (!isCampaignType(enr.campaignType)) {
    await endEnrollment(enr.id, "stopped", "unknown_campaign");
    stats.stopped++;
    return;
  }
  const def = CAMPAIGNS[enr.campaignType];

  // The guardrail gate.
  const gate = await checkEligibility(lead, enr, now);
  if (!gate.ok) {
    if (gate.action === "stop") {
      await endEnrollment(enr.id, "stopped", gate.reason);
      await writeAudit({ action: "lead.campaign.stop", entityType: "lead", entityId: lead.id, newValue: gate.reason });
      stats.stopped++;
    } else if (gate.action === "defer") {
      await prisma.campaignEnrollment.update({ where: { id: enr.id }, data: { nextRunAt: gate.until } });
      stats.deferred++;
    } else {
      await prisma.campaignEnrollment.update({ where: { id: enr.id }, data: { nextRunAt: new Date(now.getTime() + PAUSE_BUMP_MS) } });
      stats.paused++;
    }
    return;
  }

  // Send the current step (best-effort; unset template = safe no-op, schedule still advances).
  const step = def.steps[enr.step];
  const sent = !!step;
  if (step) {
    await sendAutomatedTemplate(lead.id, step.template(), [firstName(lead.name)]);
    stats.sent++;
  }

  // Advance to the next step, or complete + run the terminal action.
  const nextIndex = enr.step + 1;
  const nextDue = stepDueAt(enr.startedAt, def, nextIndex);
  if (nextDue) {
    await prisma.campaignEnrollment.update({
      where: { id: enr.id },
      data: { step: nextIndex, nextRunAt: nextDue, lastSentAt: sent ? now : enr.lastSentAt, messagesSent: { increment: sent ? 1 : 0 } },
    });
  } else {
    await prisma.campaignEnrollment.update({
      where: { id: enr.id },
      data: { status: "completed", stopReason: "completed", nextRunAt: null, stoppedAt: now, lastSentAt: sent ? now : enr.lastSentAt, messagesSent: { increment: sent ? 1 : 0 } },
    });
    await writeAudit({ action: "lead.campaign.complete", entityType: "lead", entityId: lead.id, newValue: def.label });
    stats.completed++;
    if (def.onComplete === "mark_lost") await markLostForCampaign(lead, def);
  }
}

/// One pass of the engine: process every enrollment whose nextRunAt is due. Called on an
/// interval by the worker. No-op when the global kill-switch is off. Never throws (each
/// enrollment is isolated) so one bad row can't stall the rest.
export async function runCampaignTick(now: Date = new Date()): Promise<TickStats> {
  const stats: TickStats = { processed: 0, sent: 0, stopped: 0, deferred: 0, paused: 0, completed: 0 };
  if (!campaignsEnabled()) return stats;

  const due = await prisma.campaignEnrollment.findMany({
    where: { status: "active", nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: TICK_BATCH,
  });
  for (const enr of due) {
    await processEnrollment(enr, now, stats).catch((err) =>
      logger.error(`Campaign enrollment ${enr.id} (lead ${enr.leadId}) failed this tick: ${String(err)}`),
    );
  }
  if (stats.processed > 0) {
    logger.info(`Campaign tick: ${JSON.stringify(stats)}`);
  }
  return stats;
}
