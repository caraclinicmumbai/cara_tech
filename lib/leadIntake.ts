// Central lead-intake pipeline. Every source (manual entry, website form,
// Meta/Facebook/Instagram lead ads, Google lead forms) normalises to a
// NormalizedLead and flows through ingestLead() — one place that persists the
// lead, dedupes on the provider id, and fires n8n Agent 1 for the initial call.
import type { Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { triggerOutboundCall } from "@/lib/n8n";
import { scheduleCallAttempt } from "@/lib/queue";
import { isWithinDnd } from "@/lib/callWindow";
import { logger } from "@/lib/logger";

export type LeadSource =
  | "web_form"
  | "referral"
  | "manual"
  | "walk_in"
  | "facebook"
  | "instagram"
  | "google";

export type NormalizedLead = {
  name: string;
  phone: string;
  email?: string;
  interest?: string;
  source: LeadSource;
  /// Provider's own lead id (Meta leadgen_id, Google lead_id) — used to dedupe.
  externalId?: string;
  campaign?: string;
  adId?: string;
  /// Consent capture (§3.1.13) — set for walk-in/front-desk entries.
  consentMethod?: "ipad" | "written";
  consentAt?: Date;
  consentBy?: string;
};

/// Sources that must NEVER trigger an automated AI call (§3.1.2 exceptions):
/// the lead is physically present or just spoken to, so we route to manual
/// follow-up instead. Distinct from the env-configurable PAUSE_AUTO_CALL_SOURCES.
const NEVER_AUTO_CALL: readonly LeadSource[] = ["walk_in"];

function isNeverAutoCall(source: LeadSource): boolean {
  return NEVER_AUTO_CALL.includes(source);
}

/// At least 7 digits → treat as a dialable number.
function isCallablePhone(phone: string): boolean {
  return (phone.match(/\d/g)?.length ?? 0) >= 7;
}

/// Sources whose automated outbound calls are paused: leads are still captured
/// and stored, but no initial AI call is fired. Reversible via env without code
/// changes. Set PAUSE_AUTO_CALL_SOURCES to a comma list, e.g. "facebook,instagram".
function isAutoCallPaused(source: LeadSource): boolean {
  return (process.env.PAUSE_AUTO_CALL_SOURCES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(source);
}

export type IngestResult = {
  lead: Lead;
  /// True when an existing lead was returned instead of creating a duplicate.
  deduped: boolean;
};

/// Persist a normalised lead and trigger the initial AI call.
/// Idempotent per (source, externalId): a repeated ad-webhook delivery returns
/// the existing lead and does NOT re-trigger a call.
export async function ingestLead(input: NormalizedLead): Promise<IngestResult> {
  if (input.externalId) {
    const existing = await prisma.lead.findFirst({
      where: { source: input.source, externalId: input.externalId },
    });
    if (existing) {
      logger.info(
        `Duplicate lead ignored (${input.source}/${input.externalId}) → ${existing.id}`,
      );
      return { lead: existing, deduped: true };
    }
  }

  // Walk-in/front-desk leads go straight to the manual follow-up queue —
  // a human is already with the patient, so there's no AI cold-call (§3.1.2).
  const neverCall = isNeverAutoCall(input.source);

  const lead = await prisma.lead.create({
    data: {
      name: input.name,
      phone: input.phone,
      email: input.email,
      interest: input.interest,
      source: input.source,
      status: neverCall ? "manual_followup" : "new",
      externalId: input.externalId,
      campaign: input.campaign,
      adId: input.adId,
      consentMethod: input.consentMethod,
      consentAt: input.consentAt,
      consentBy: input.consentBy,
    },
  });

  logger.info(`Lead created ${lead.id} via ${input.source}`);

  // Hard no-call source (walk-in/front-desk) — captured, never auto-dialed.
  if (neverCall) {
    logger.info(`No auto-call for source=${input.source}; lead ${lead.id} routed to manual follow-up`);
    return { lead, deduped: false };
  }

  // Auto-calling paused for this source (e.g. Meta, pending App Review) — capture only.
  if (isAutoCallPaused(input.source)) {
    logger.info(`Auto-call paused for source=${input.source}; lead ${lead.id} saved without calling`);
    return { lead, deduped: false };
  }

  // Only place a call when we have a usable phone number — ad forms can omit it.
  if (!isCallablePhone(lead.phone)) {
    logger.warn(`Lead ${lead.id} has no callable phone — saved without triggering a call`);
    return { lead, deduped: false };
  }

  // Do-not-call window (§3.1.2): leads arriving 22:00–10:00 IST are held and
  // released — FIFO, concurrency-capped — at the next permitted window via the
  // call queue (the worker fires the held attempt). Daytime leads call instantly.
  if (isWithinDnd()) {
    try {
      await scheduleCallAttempt({
        leadId: lead.id,
        phone: lead.phone,
        attempt: 1,
        callType: "initial",
      });
      logger.info(`Lead ${lead.id} created in do-not-call window — held for next permitted window`);
    } catch (err) {
      logger.error(`Failed to queue held call for lead ${lead.id}: ${String(err)}`);
    }
    return { lead, deduped: false };
  }

  // Don't fail intake if n8n is momentarily unavailable — the lead is saved.
  try {
    await triggerOutboundCall({
      leadId: lead.id,
      name: lead.name,
      phone: lead.phone,
      interest: lead.interest ?? undefined,
      source: lead.source ?? undefined,
      callType: "initial",
    });
  } catch (err) {
    logger.error(`Failed to trigger outbound call for lead ${lead.id}: ${String(err)}`);
  }

  return { lead, deduped: false };
}
