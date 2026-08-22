// Central lead-intake pipeline. Every source (manual entry, website form,
// Meta/Facebook/Instagram lead ads, Google lead forms) normalises to a
// NormalizedLead and flows through ingestLead() — one place that persists the
// lead, dedupes on the provider id, and fires n8n Agent 1 for the initial call.
import type { Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { placeOutboundCall } from "@/lib/providers/elevenlabs";
import { scheduleCallAttempt, cancelScheduledCalls, aiCallsPaused } from "@/lib/queue";
import { pickOwnerRep, assignLeadToRep } from "@/lib/salesReps";
import { seedFollowUpStepsSafe } from "@/lib/followups";
import { isWithinDnd } from "@/lib/callWindow";
import { sendAutomatedTemplate, outreachTemplate, firstName } from "@/lib/outreach";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export type LeadSource =
  | "web_form"
  | "referral"
  | "manual"
  | "walk_in"
  | "facebook"
  | "instagram"
  | "google"
  | "whatsapp"
  | "inbound_call";

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
  /// Anti-spam hold (§3.1): a burst of submissions from one IP. The lead is
  /// still captured but routed to manual review and never auto-called.
  heldForReview?: boolean;
  heldReason?: string;
  /// The login (User.id) that created this lead — for Front-Desk "own leads"
  /// scoping. Set for staff-entered leads (manual / walk-in); null for intake.
  createdById?: string;
};

/// Consent basis for a self-served DIGITAL source (§compliance C2). Meta/Google
/// lead ads and the website form make the person accept a privacy notice before
/// submitting, and a WhatsApp message is user-initiated — so ingestion itself is
/// evidence of consent to be contacted about the enquiry. Returns null for
/// staff-entered / referral sources (walk-ins carry an explicit iPad/written form
/// captured at the clinic; those consent fields arrive on the NormalizedLead).
function digitalConsentBasis(source: LeadSource): string | null {
  switch (source) {
    case "web_form":
      return "Website enquiry form — privacy notice accepted at submission";
    case "facebook":
    case "instagram":
      return "Meta Lead Ad — privacy policy accepted on the ad form";
    case "google":
      return "Google Lead Form — privacy policy accepted on the form";
    case "whatsapp":
      return "User-initiated WhatsApp contact";
    case "inbound_call":
      return "Patient called the clinic line — user-initiated contact";
    default:
      return null; // manual | referral | walk_in — consent captured elsewhere
  }
}

/// Sources that must NEVER trigger an automated AI call (§3.1.2 exceptions):
/// the lead is physically present or just spoken to, so we route to manual
/// follow-up instead. Distinct from the env-configurable PAUSE_AUTO_CALL_SOURCES.
/// `inbound_call` is here for the same reason as `walk_in`: the person is ON THE PHONE
/// with us. Firing an automated AI cold-call at someone who just rang the clinic is the
/// worst possible first impression, so inbound callers go to the manual queue instead.
const NEVER_AUTO_CALL: readonly LeadSource[] = ["walk_in", "inbound_call"];

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

/// Find a pre-existing lead matching this one on PHONE only (last 10 digits, to
/// span +91/bare formats) — §3.1.1 duplicate detection. Email is intentionally NOT
/// matched: two leads may legitimately share an email (e.g. a family member's), so
/// only a repeated phone number marks a duplicate. Returns the OLDEST match (the
/// "original") so duplicates chain to one canonical record.
async function findDuplicateLead(phone: string): Promise<Lead | null> {
  const last10 = (phone.match(/\d/g)?.join("") ?? "").slice(-10);
  if (last10.length < 7) return null;
  return prisma.lead.findFirst({
    where: { deletedAt: null, phone: { contains: last10 } },
    orderBy: { createdAt: "asc" },
  });
}

/// Opt out every lead matching a phone (last 10 digits) and cancel their pending
/// calls (§3.1.10). Used by the WhatsApp "STOP" handler and any opt-out trigger.
/// Returns how many leads were suppressed.
export async function optOutLeadsByPhone(phone: string, reason: string): Promise<number> {
  const last10 = (phone.match(/\d/g)?.join("") ?? "").slice(-10);
  if (last10.length < 7) return 0;
  const leads = await prisma.lead.findMany({
    where: { phone: { contains: last10 }, deletedAt: null },
    select: { id: true },
  });
  for (const l of leads) {
    await prisma.lead.update({
      where: { id: l.id },
      data: { optedOut: true, optedOutAt: new Date(), optedOutReason: reason },
    });
    await writeAudit({
      action: "lead.consent.change", entityType: "lead", entityId: l.id,
      field: "optedOut", oldValue: "false", newValue: "true", reason,
    });
    await cancelScheduledCalls(l.id);
  }
  if (leads.length) logger.info(`Opted out ${leads.length} lead(s) by phone (${reason})`);
  return leads.length;
}

export type IngestResult = {
  lead: Lead;
  /// True when an existing lead was returned instead of creating a duplicate.
  deduped: boolean;
  /// Set when this new lead matches an existing one (phone/email) — the caller
  /// surfaces a merge prompt; the lead is queued for manual review, not called.
  duplicateOfId?: string;
};

/// Persist a normalised lead and trigger the initial AI call.
/// Idempotent per (source, externalId): a repeated ad-webhook delivery returns
/// the existing lead and does NOT re-trigger a call.
export async function ingestLead(input: NormalizedLead): Promise<IngestResult> {
  if (input.externalId) {
    const existing = await prisma.lead.findFirst({
      where: { source: input.source, externalId: input.externalId, deletedAt: null },
    });
    if (existing) {
      logger.info(
        `Duplicate lead ignored (${input.source}/${input.externalId}) → ${existing.id}`,
      );
      return { lead: existing, deduped: true };
    }
  }

  // Duplicate detection (§3.1.1): a matching PHONE means a prior record exists —
  // capture the new enquiry but link it, route to manual review, and never AI-call
  // it (the counsellor reviews/merges first). Email is not used for matching.
  const dup = await findDuplicateLead(input.phone);

  // Walk-in/front-desk leads go straight to the manual follow-up queue —
  // a human is already with the patient, so there's no AI cold-call (§3.1.2).
  const neverCall = isNeverAutoCall(input.source);
  const held = !!input.heldForReview;
  const manualQueue = neverCall || !!dup || held;

  // Consent capture (§compliance C2). An explicit walk-in consent (input.consent*)
  // always wins; otherwise a self-served digital source evidences consent to be
  // contacted about the enquiry at the moment of ingest. Stored on the record AND
  // written to the audit trail so "when/how did we get consent" is answerable.
  const now = new Date();
  const consentBasis = digitalConsentBasis(input.source);
  const consentMethod = input.consentMethod ?? (consentBasis ? "digital_form" : undefined);
  const consentAt = input.consentAt ?? (consentBasis ? now : undefined);

  const lead = await prisma.lead.create({
    data: {
      name: input.name,
      phone: input.phone,
      email: input.email,
      interest: input.interest,
      source: input.source,
      status: manualQueue ? "manual_followup" : "new",
      duplicateOfId: dup?.id,
      heldForReview: held,
      heldAt: held ? new Date() : undefined,
      heldReason: held ? input.heldReason : undefined,
      externalId: input.externalId,
      campaign: input.campaign,
      adId: input.adId,
      consentMethod,
      consentAt,
      consentBy: input.consentBy,
      // Per-channel consent for digital enquiries — they submitted a form asking to
      // be contacted, so call + marketing consent is recorded (checked before every
      // outreach). Left untouched for staff-entered/referral sources (null = unknown).
      consentCall: consentBasis ? true : undefined,
      consentMarketing: consentBasis ? true : undefined,
      consentUpdatedAt: consentBasis ? now : undefined,
      createdById: input.createdById,
    },
  });

  // Record the consent basis in the immutable audit trail (§compliance C2).
  if (consentBasis) {
    await writeAudit({
      action: "lead.consent.change", entityType: "lead", entityId: lead.id,
      field: "consent", oldValue: null, newValue: "captured", reason: consentBasis,
    }).catch((err) => logger.error(`Consent audit failed for lead ${lead.id}: ${String(err)}`));
  }

  // Ownership (§3.1 RBAC): every new lead — including walk-ins and duplicates —
  // gets a telecaller owner (round-robin) at intake, so "my leads" scoping works
  // and there's someone to follow up. NO notification here; a later handover pings
  // this owner (see notifyHandover). pickOwnerRep prefers an available counsellor
  // but falls back to any active one, so a team that's all on break still leaves
  // the lead owned. Best-effort — only a roster with NO active rep leaves it blank.
  let ownerRepId: string | null = null;
  try {
    const owner = await pickOwnerRep();
    if (owner) {
      await assignLeadToRep(lead.id, owner.id);
      ownerRepId = owner.id;
    } else {
      logger.warn(`Lead ${lead.id} created with no owner — no active sales rep on the roster`);
    }
  } catch (err) {
    logger.error(`Failed to assign owner for lead ${lead.id}: ${String(err)}`);
  }

  // Seed the follow-up roadmap (§follow-up roadmap) for leads we'll actively
  // pursue — skip duplicates and held-for-review leads (no AI call, manual vetting
  // first), so their roadmap starts empty and staff add steps by hand. Best-effort.
  if (!dup && !held) {
    await seedFollowUpStepsSafe({ leadId: lead.id, ownerRepId, startAt: now });
  }

  // Duplicate → manual queue, no AI call, merge prompt surfaced via the result.
  if (dup) {
    logger.info(`Lead ${lead.id} is a possible duplicate of ${dup.id} (phone/email) — manual review, no call`);
    return { lead, deduped: false, duplicateOfId: dup.id };
  }

  logger.info(`Lead created ${lead.id} via ${input.source}`);

  // Held for review (§3.1) — submission burst from one IP. Captured, flagged for
  // a human to vet, and never auto-called until they clear it.
  if (held) {
    logger.warn(`Lead ${lead.id} held for review (${input.heldReason ?? "flagged"}) — no AI call`);
    return { lead, deduped: false };
  }

  // Hard no-call source (walk-in/front-desk) — captured, never auto-dialed.
  if (neverCall) {
    logger.info(`No auto-call for source=${input.source}; lead ${lead.id} routed to manual follow-up`);
    return { lead, deduped: false };
  }

  // Welcome WhatsApp (§3.1.3) — best-effort, OFF unless WHATSAPP_TEMPLATE_NEW_LEAD
  // is set. Fires for real new leads (not duplicates/walk-ins/held), even for
  // call-paused sources. If they reply, it opens the 24h window for follow-up.
  await sendAutomatedTemplate(lead.id, outreachTemplate.newLead(), [firstName(lead.name)]);

  // Global kill-switch (§3.1) — AI_CALLS_PAUSED halts ALL automated outbound calls
  // (this immediate intake call AND any DND-held/queued attempts). The lead is still
  // captured; nothing is dialled or queued. Rep click-to-call is unaffected.
  if (aiCallsPaused()) {
    logger.info(`AI calls paused (AI_CALLS_PAUSED) — lead ${lead.id} saved without calling`);
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

  // Don't fail intake if ElevenLabs is momentarily unavailable — the lead is saved.
  try {
    await placeOutboundCall({
      leadId: lead.id,
      name: lead.name,
      phone: lead.phone,
      interest: lead.interest ?? undefined,
      callType: "initial",
    });
  } catch (err) {
    logger.error(`Failed to trigger outbound call for lead ${lead.id}: ${String(err)}`);
  }

  return { lead, deduped: false };
}
