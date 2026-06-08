// Central lead-intake pipeline. Every source (manual entry, website form,
// Meta/Facebook/Instagram lead ads, Google lead forms) normalises to a
// NormalizedLead and flows through ingestLead() — one place that persists the
// lead, dedupes on the provider id, and fires n8n Agent 1 for the initial call.
import type { Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { triggerOutboundCall } from "@/lib/n8n";
import { logger } from "@/lib/logger";

export type LeadSource =
  | "web_form"
  | "referral"
  | "manual"
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
};

/// At least 7 digits → treat as a dialable number.
function isCallablePhone(phone: string): boolean {
  return (phone.match(/\d/g)?.length ?? 0) >= 7;
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

  const lead = await prisma.lead.create({
    data: {
      name: input.name,
      phone: input.phone,
      email: input.email,
      interest: input.interest,
      source: input.source,
      externalId: input.externalId,
      campaign: input.campaign,
      adId: input.adId,
    },
  });

  logger.info(`Lead created ${lead.id} via ${input.source}`);

  // Only place a call when we have a usable phone number — ad forms can omit it.
  if (!isCallablePhone(lead.phone)) {
    logger.warn(`Lead ${lead.id} has no callable phone — saved without triggering a call`);
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
