// Conversation Quality Score (CQS, §3.1). One uniform 0–100 score for EVERY call
// — AI or human — judged by Claude against a fixed 6-dimension rubric. The model
// scores each dimension 0–100; we combine them with the rubric weights.
//
// Best-effort: if the Anthropic API isn't configured or the call fails, scoring
// returns null and the caller proceeds without a CQS (never blocks call intake).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { logger } from "@/lib/logger";

// Rubric weights (sum = 1.0). Each dimension is scored 0–100 by the model.
export const CQS_WEIGHTS = {
  intent_clarity: 0.2,
  engagement_level: 0.2,
  urgency_signal: 0.15,
  objection: 0.15,
  consent_compliance: 0.2,
  escalation: 0.1,
} as const;

// Structured output the model must return.
const cqsSchema = z.object({
  intent_clarity: z.number().min(0).max(100).describe("Did the lead articulate a clear need or treatment interest?"),
  engagement_level: z.number().min(0).max(100).describe("Did the lead ask questions, provide detail, stay on the line?"),
  urgency_signal: z.number().min(0).max(100).describe("Did the lead indicate a timeline or urgency?"),
  objection_type: z.enum(["cost", "time", "trust", "exploring", "none"]).describe("The lead's primary objection, by keyword pattern."),
  objection: z.number().min(0).max(100).describe("Objection-handling quality: a resolvable/engaged objection scores high; 'just exploring' or unresolved scores low; none = high."),
  consent_compliance: z.number().min(0).max(100).describe("Was recording consent acknowledged, and did the agent avoid making pricing/clinical commitments?"),
  escalation: z.number().min(0).max(100).describe("Was any human-escalation trigger handled appropriately? No escalation needed = high."),
  summary: z.string().describe("One sentence summarising the call quality."),
});

export type CqsBreakdown = z.infer<typeof cqsSchema>;
export type CqsResult = { cqs: number; breakdown: CqsBreakdown };

const SYSTEM = `You are a sales-call quality evaluator for Cara Clinic, a hair-transplant & aesthetic clinic in Mumbai. You score a single call transcript (AI agent or human telecaller with a patient lead) against a fixed rubric.

Score EACH dimension from 0 to 100 based ONLY on what the transcript shows:
- Intent Clarity (20%): did the lead articulate a clear need or treatment interest?
- Engagement Level (20%): did the lead ask questions, provide detail, stay on the line?
- Urgency Signal (15%): did the lead indicate a timeline or urgency?
- Objection (15%): classify the objection (cost/time/trust/exploring/none) and score how resolvable/engaged it is — a genuine, addressable objection scores higher than "just exploring"; no objection scores high.
- Consent & Compliance (20%): was recording consent acknowledged, and did the agent avoid making specific pricing or clinical commitments? Improper commitments score low.
- Escalation (10%): if a human-escalation trigger occurred, was it handled appropriately? If none was needed, score high.

Be objective and consistent. Base scores on evidence in the transcript, not assumptions.`;

export function isCqsConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

function cqsModel(): string {
  return process.env.CQS_MODEL ?? "claude-opus-4-8";
}

/// Weighted 0–100 CQS from the per-dimension scores.
export function computeCqs(b: CqsBreakdown): number {
  const total =
    b.intent_clarity * CQS_WEIGHTS.intent_clarity +
    b.engagement_level * CQS_WEIGHTS.engagement_level +
    b.urgency_signal * CQS_WEIGHTS.urgency_signal +
    b.objection * CQS_WEIGHTS.objection +
    b.consent_compliance * CQS_WEIGHTS.consent_compliance +
    b.escalation * CQS_WEIGHTS.escalation;
  return Math.round(total);
}

/// Score a call transcript with Claude against the rubric. Returns null when the
/// API isn't configured, the transcript is empty, or the call fails.
export async function scoreCQS(transcript?: string | null): Promise<CqsResult | null> {
  const text = transcript?.trim();
  if (!text) return null;
  if (!isCqsConfigured()) {
    logger.warn("CQS scoring skipped — ANTHROPIC_API_KEY not set");
    return null;
  }

  try {
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: cqsModel(),
      max_tokens: 1024,
      system: SYSTEM,
      output_config: { format: zodOutputFormat(cqsSchema) },
      messages: [{ role: "user", content: `Score this call transcript:\n\n${text.slice(0, 12000)}` }],
    });
    const breakdown = res.parsed_output;
    if (!breakdown) {
      logger.error(`CQS scoring returned no parsed output (stop=${res.stop_reason})`);
      return null;
    }
    return { cqs: computeCqs(breakdown), breakdown };
  } catch (err) {
    logger.error(`CQS scoring failed: ${String(err)}`);
    return null;
  }
}
