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
import { pickNextRep, assignLeadToRep } from "@/lib/salesReps";
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
  if (base) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open lead" }, url: `${base}/leads/${lead.id}` },
      ],
    });
  }

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

  // Round-robin assignment (no-op if no reps configured yet) — happens even when
  // Slack isn't set up, so the lead still gets an owner.
  const rep = await pickNextRep();
  if (rep) await assignLeadToRep(lead.id, rep.id);

  if (!isSlackConfigured()) return;

  const assignee = rep?.slackUserId ? `<@${rep.slackUserId}>` : (rep?.name ?? "the team");
  const hot = fired.some((f) => f.key === "high_cqs");
  const { text, blocks } = buildEscalationMessage({ lead, fired, assignee, transcript, cqs, hot });

  // DM the assigned rep if we have their Slack id; otherwise the default channel.
  await sendSlack({ text, blocks, channel: rep?.slackUserId ?? undefined });
  logger.info(
    `${hot ? "Hot-lead escalation" : "Handover alert"} for lead ${lead.id} → ${rep?.name ?? "channel"}: ${fired.map((f) => f.key).join(",")}`,
  );
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
