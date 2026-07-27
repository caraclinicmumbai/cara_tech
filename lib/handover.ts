// AI→human handover (§3.1). When an AI call hits a trigger, the lead is routed
// to the sales team rather than left in the automated drip. This module owns the
// trigger catalogue, the evaluation (which triggers fired for a call), and the
// Slack alert. The actual routing (status + cancel drip + persist) happens in
// lib/callIntake.recordCall using evaluateHandover()'s result.
//
// Triggers come from two places:
//  • the ElevenLabs agent / scoring model, as explicit reason keys + booleans
//    (it understands the conversation) — passed through as `reasons`;
//  • thresholds we own here — CQS ≥ 75 (fast-track) and unsupported language.
import type { Lead } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { pickNextRep, pickReplacementFor, assignLeadToRep, getLeadOwner } from "@/lib/salesReps";
import { managerSlackTarget } from "@/lib/presence";
import { logger } from "@/lib/logger";

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/// Every handover trigger → the human-readable reason shown to the counsellor.
export const HANDOVER_TRIGGERS = {
  price_request: "Asked for a price or quote",
  clinical_question: "Asked a clinical question (pattern / eligibility / technique)",
  emotional_distress: "Expressed distress, urgency, or a medical signal",
  wants_human: "Requested to speak to a doctor or a person",
  competitor_mention: "Mentioned a competitor by name (high-intent comparison)",
  unresolved_objection: "Call ended with an unresolved objection",
  high_cqs: "High-quality lead (CQS ≥ threshold) — fast-track to counsellor",
  unsupported_language: "Speaking an unsupported language",
  hearing_impaired: "Flagged as hearing-impaired",
  abusive: "Made an abusive statement or threat",
  wrong_person_landline: "Landline answered by someone other than the lead",
} as const;

export type HandoverTrigger = keyof typeof HANDOVER_TRIGGERS;

export function isHandoverTrigger(k: string): k is HandoverTrigger {
  return Object.prototype.hasOwnProperty.call(HANDOVER_TRIGGERS, k);
}

function cqsThreshold(): number {
  return Number(process.env.HANDOVER_CQS_THRESHOLD ?? 75);
}

/// Is this score high enough to escalate as a hot lead (CQS ≥ threshold)?
export function isEscalationScore(cqs?: number | null): boolean {
  return typeof cqs === "number" && !Number.isNaN(cqs) && cqs >= cqsThreshold();
}

/// Languages the AI agent can handle. Anything else → manual handover. Codes are
/// matched case-insensitively on the first token (so "ta-IN" or "Tamil" → "ta"/"tamil").
function supportedLanguages(): string[] {
  // Hindi/Hinglish + English only — matches the AI agent's First Call Rulebook
  // (§2, Commandment #4). Any other language (incl. Marathi) routes to a human.
  return (process.env.HANDOVER_SUPPORTED_LANGUAGES ?? "en,hi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isLanguageSupported(lang: string): boolean {
  const norm = lang.trim().toLowerCase().split(/[-\s]/)[0]!;
  const set = supportedLanguages();
  return set.includes(norm) || set.some((s) => norm.startsWith(s));
}

export type HandoverInput = {
  /// Explicit trigger keys flagged by the agent/scoring model (unknown keys ignored).
  reasons?: string[];
  /// Conversation Quality Score 0–100 (≥ threshold → fast-track).
  cqs?: number;
  /// Detected spoken language (code or name).
  language?: string;
};

export type FiredTrigger = { key: HandoverTrigger; label: string };

/// Decide which handover triggers fired for a call. Dedups, validates keys, and
/// applies the CQS / language thresholds we own. Empty array = no handover.
export function evaluateHandover(input: HandoverInput): FiredTrigger[] {
  const keys = new Set<HandoverTrigger>();

  for (const r of input.reasons ?? []) {
    const k = r.trim();
    if (isHandoverTrigger(k)) keys.add(k);
  }
  if (typeof input.cqs === "number" && !Number.isNaN(input.cqs) && input.cqs >= cqsThreshold()) {
    keys.add("high_cqs");
  }
  if (input.language && input.language.trim() && !isLanguageSupported(input.language)) {
    keys.add("unsupported_language");
  }

  return [...keys].map((key) => ({ key, label: HANDOVER_TRIGGERS[key] }));
}

/// Build the Slack message (text + blocks) for an escalation. A HOT lead (CQS ≥
/// threshold) gets a distinct 🔥 "close now" treatment — leading with the score —
/// so a counsellor can tell a ready-to-buy lead from a problem-handover at a
/// glance. Everything else keeps the 🤝 "handover to sales" framing.
export function buildEscalationMessage(opts: {
  lead: Pick<Lead, "id" | "name" | "phone">;
  fired: FiredTrigger[];
  assignee: string;
  transcript?: string;
  cqs?: number;
  hot: boolean;
}): { text: string; blocks: unknown[] } {
  const { lead, fired, assignee, transcript, cqs, hot } = opts;
  const base = process.env.NEXTAUTH_URL;
  const telPhone = lead.phone.replace(/[^\d+]/g, "");
  const phoneLink = `<tel:${telPhone}|📞 ${lead.phone}>`;
  const cqsTag = typeof cqs === "number" ? ` — CQS ${cqs}` : "";
  const header = hot ? `🔥 Hot lead — close now${cqsTag}` : "🤝 Handover to sales";

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: header, emoji: true } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${lead.name}* — ${phoneLink}\nAssigned to ${assignee}` },
    },
  ];
  if (hot) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:fire: *High-intent lead (CQS ${cqs ?? "≥ threshold"})* — prioritise the close.`,
      },
    });
  }
  if (fired.length) {
    const reasons = fired.map((f) => `• ${f.label}`).join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${hot ? "Signals" : "Why handed over"}:*\n${reasons}` },
    });
  }
  if (transcript?.trim()) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Call transcript:*\n${truncate(transcript.trim(), 2600)}` },
    });
  }
  // Action buttons: "Call & record" (interactive — handled by /api/slack/interact:
  // rings the rep who clicks, then dials + records the lead) and "Open lead".
  const elements: unknown[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "📞 Call & record", emoji: true },
      action_id: "call_and_record",
      value: lead.id,
      style: "primary",
    },
  ];
  if (base) {
    elements.push({ type: "button", text: { type: "plain_text", text: "Open lead" }, url: `${base}/leads/${lead.id}` });
  }
  blocks.push({ type: "actions", elements });

  // Fallback plain text (shown in notifications / if blocks unsupported).
  const text = hot
    ? `🔥 Hot lead${cqsTag} — ${lead.name} (${lead.phone}) — prioritise the close`
    : `🤝 Handover to sales — ${lead.name} (${lead.phone}): ${fired.map((f) => f.label).join("; ")}`;
  return { text, blocks };
}

/// Route a handover to a sales rep (round-robin) and DM them individually on Slack
/// with the reason(s), the call transcript, and a tap-to-call link. A CQS-driven
/// escalation (high_cqs fired) renders as a distinct 🔥 hot-lead alert. Falls back
/// to the default channel if no rep (or no Slack id). Best-effort (never throws).
export async function notifyHandover(
  lead: Pick<Lead, "id" | "name" | "phone">,
  fired: FiredTrigger[],
  transcript?: string,
  cqs?: number,
): Promise<void> {
  if (fired.length === 0) return;

  // The lead already has an owner (assigned round-robin at intake, §3.1 RBAC) — the
  // handover notifies THAT person, it doesn't re-assign. Fall back to round-robin
  // only for legacy leads that predate ownership assignment.
  let rep = await getLeadOwner(lead.id);
  if (!rep) {
    rep = await pickNextRep();
    if (rep) await assignLeadToRep(lead.id, rep.id);
  }

  const hot = fired.some((f) => f.key === "high_cqs");

  // §presence: if the owner isn't Active (on a call, on break, or offline), reassign
  // the handover to an available colleague — preferring the same speciality — so
  // "go call them now" lands with someone who can act. A hot lead that arrives while
  // the owner is mid-consultation ALSO pings their manager (urgent escalation).
  let managerTarget: string | undefined;
  if (rep && rep.availability !== "available") {
    if (rep.availability === "in_consultation" && hot) {
      managerTarget = await managerSlackTarget(rep);
    }
    const replacement = await pickReplacementFor({ id: rep.id, speciality: rep.speciality });
    if (replacement) {
      await assignLeadToRep(lead.id, replacement.id);
      logger.info(`Handover rerouted for lead ${lead.id}: owner ${rep.name} was ${rep.availability} → ${replacement.name}`);
      rep = replacement;
    }
  }

  if (!isSlackConfigured()) return;

  const assignee = rep?.slackUserId ? `<@${rep.slackUserId}>` : (rep?.name ?? "the team");
  const { text, blocks } = buildEscalationMessage({ lead, fired, assignee, transcript, cqs, hot });

  // DM the assigned rep if we have their Slack id; otherwise the default channel.
  await sendSlack({ text, blocks, channel: rep?.slackUserId ?? undefined });
  logger.info(
    `${hot ? "Hot-lead escalation" : "Handover alert"} for lead ${lead.id} → ${rep?.name ?? "channel"}: ${fired.map((f) => f.key).join(",")}`,
  );

  // Urgent: hot lead landed while the owner was in consultation → also tell the manager.
  if (managerTarget) {
    await sendSlack({
      channel: managerTarget,
      text:
        `🚨 Hot lead *${lead.name}* (${lead.phone}) arrived while the counsellor was in consultation — ` +
        `reassigned to ${rep?.name ?? "the team"}. Please make sure it's picked up.`,
    }).catch(() => {});
  }
}

/// Escalate a recorded HUMAN call that scored hot (CQS ≥ threshold). Unlike the AI
/// path, the lead is already owned (it was a handover), so this RAISES the
/// escalation flag (idempotently merging high_cqs into the triggers) and pings the
/// owning rep — or the channel — that the lead is high-intent and worth
/// prioritising. Non-destructive to any existing handover reason. Best-effort.
export async function escalateHotCall(
  lead: Pick<Lead, "id" | "name" | "phone" | "assignedRepId" | "handoverTriggers" | "handoverReason">,
  cqs: number,
  transcript?: string,
): Promise<void> {
  const triggers = new Set([...(lead.handoverTriggers ?? []), "high_cqs"]);
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      needsHandover: true,
      handoverAt: new Date(),
      handoverTriggers: [...triggers],
      // Keep the original handover reason if there was one; only fill if empty.
      handoverReason: lead.handoverReason ?? HANDOVER_TRIGGERS.high_cqs,
    },
  });

  if (!isSlackConfigured()) return;

  const rep = lead.assignedRepId
    ? await prisma.salesRep.findUnique({ where: { id: lead.assignedRepId } })
    : null;
  const assignee = rep?.slackUserId ? `<@${rep.slackUserId}>` : (rep?.name ?? "the team");
  const fired: FiredTrigger[] = [{ key: "high_cqs", label: HANDOVER_TRIGGERS.high_cqs }];
  const { text, blocks } = buildEscalationMessage({ lead, fired, assignee, transcript, cqs, hot: true });

  await sendSlack({ text, blocks, channel: rep?.slackUserId ?? undefined });
  logger.info(`Hot-call escalation for lead ${lead.id} (CQS ${cqs}) → ${rep?.name ?? "channel"}`);
}
