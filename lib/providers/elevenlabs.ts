// ElevenLabs Conversational AI adapter.
//
// Two responsibilities:
//   1. Shape + (optionally) place the OUTBOUND call. In the blueprint topology
//      n8n Agent 1 makes this HTTP call; buildOutboundCallRequest() documents the
//      exact contract, and placeOutboundCall() lets the app call ElevenLabs
//      directly if you skip n8n.
//   2. Handle the POST-CALL webhook: verify the HMAC signature and map the
//      payload to our Call shape.
//
// Docs: https://elevenlabs.io/docs/conversational-ai (outbound calling + webhooks)
import { createHmac, timingSafeEqual } from "crypto";
import axios from "axios";
import type { RecordCallInput } from "@/lib/callIntake";
import type { z } from "zod";
import type { elevenLabsPostCallSchema } from "@/lib/contracts";

const API_BASE = "https://api.elevenlabs.io";

// "twilio" (default) or "sip_trunk" — the outbound call transport.
function outboundEndpoint(): string {
  const method = (process.env.ELEVENLABS_OUTBOUND_METHOD ?? "twilio").toLowerCase();
  return method === "sip_trunk" || method === "sip"
    ? `${API_BASE}/v1/convai/sip-trunk/outbound-call`
    : `${API_BASE}/v1/convai/twilio/outbound-call`;
}

export type OutboundCallContext = {
  leadId: string;
  name: string;
  phone: string; // E.164
  callType: "initial" | "reconfirmation";
  interest?: string;
  /// Prior-call summary, for re-confirmation personalisation.
  context?: string;
};

/// Build the exact request (url, headers, body) for an ElevenLabs outbound call.
/// The `dynamic_variables` round-trip: they come back in the post-call webhook,
/// so we stash leadId + callType there to correlate the result.
export function buildOutboundCallRequest(ctx: OutboundCallContext) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const agentPhoneNumberId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID;

  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is not configured");
  if (!agentPhoneNumberId)
    throw new Error("ELEVENLABS_AGENT_PHONE_NUMBER_ID is not configured");

  return {
    url: outboundEndpoint(),
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: {
      agent_id: agentId,
      agent_phone_number_id: agentPhoneNumberId,
      to_number: ctx.phone,
      conversation_initiation_client_data: {
        dynamic_variables: {
          lead_id: ctx.leadId,
          call_type: ctx.callType,
          lead_name: ctx.name,
          interest: ctx.interest ?? "",
          prior_context: ctx.context ?? "",
        },
      },
    },
  };
}

/// Place the outbound call directly from the app (alternative to n8n Agent 1).
export async function placeOutboundCall(ctx: OutboundCallContext) {
  const { url, headers, body } = buildOutboundCallRequest(ctx);
  const res = await axios.post(url, body, { headers, timeout: 20_000 });
  return res.data;
}

// ── Post-call webhook ────────────────────────────────────────────────

/// Verify the ElevenLabs post-call webhook HMAC.
/// Header format: `ElevenLabs-Signature: t=<unix>,v0=<hex hmac>`,
/// signed payload = `${t}.${rawBody}` with the webhook secret.
export function verifyElevenLabsSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts["t"];
  const v0 = parts["v0"];
  if (!t || !v0) return false;

  const expected = "v0=" + createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v0.startsWith("v0=") ? v0 : `v0=${v0}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

type PostCall = z.infer<typeof elevenLabsPostCallSchema>;

/// Coarse outcome fallback derived from call_successful when the agent didn't
/// collect a structured "outcome" data point.
function outcomeFromSuccess(callSuccessful?: string): string | undefined {
  if (callSuccessful === "success") return "confirmed";
  if (callSuccessful === "failure") return "no_answer";
  return undefined;
}

/// Flatten the transcript turns into a readable string.
function flattenTranscript(turns?: PostCall["data"]["transcript"]): string | undefined {
  if (!turns?.length) return undefined;
  return turns
    .map((t) => `${t.role}: ${t.message ?? ""}`.trim())
    .filter(Boolean)
    .join("\n");
}

// Data-collection keys the agent may set as booleans → handover trigger keys.
const HANDOVER_BOOLEAN_FIELDS: Record<string, string> = {
  asked_price: "price_request",
  price_request: "price_request",
  clinical_question: "clinical_question",
  emotional_distress: "emotional_distress",
  wants_human: "wants_human",
  competitor_mention: "competitor_mention",
  unresolved_objection: "unresolved_objection",
  hearing_impaired: "hearing_impaired",
  abusive: "abusive",
  wrong_person_landline: "wrong_person_landline",
};

function isTruthy(v?: string): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "y";
}

/// Build the handover trigger keys the agent flagged: an explicit comma-separated
/// `handover_reasons`/`handover_reason` data point, plus any known boolean fields.
function collectHandoverReasons(collected: Record<string, { value?: string }>): string[] {
  const out = new Set<string>();
  const explicit = `${collected.handover_reasons?.value ?? ""},${collected.handover_reason?.value ?? ""}`;
  for (const r of explicit.split(",").map((s) => s.trim()).filter(Boolean)) out.add(r);
  for (const [field, key] of Object.entries(HANDOVER_BOOLEAN_FIELDS)) {
    if (isTruthy(collected[field]?.value)) out.add(key);
  }
  return [...out];
}

/// Map an ElevenLabs post-call payload to our recordCall input.
/// Returns null when leadId can't be recovered (so the caller can 400/ignore).
export function mapElevenLabsPostCall(payload: PostCall): RecordCallInput | null {
  const data = payload.data;
  const dyn = data.conversation_initiation_client_data?.dynamic_variables ?? {};
  const leadId = dyn.lead_id;
  if (!leadId) return null;

  const callType = dyn.call_type === "reconfirmation" ? "reconfirmation" : "initial";
  const collected = data.analysis?.data_collection_results ?? {};
  const cqsRaw = collected.cqs?.value;
  const cqs = cqsRaw != null && cqsRaw !== "" ? Number(cqsRaw) : undefined;

  return {
    leadId,
    callType,
    elevenlabsId: data.conversation_id,
    transcript: flattenTranscript(data.transcript) ?? data.analysis?.transcript_summary,
    outcome:
      collected.outcome?.value ?? outcomeFromSuccess(data.analysis?.call_successful),
    sentiment: collected.sentiment?.value,
    duration: data.metadata?.call_duration_secs,
    // ISO datetime the agent captured when the lead requested a callback (§3.1.2).
    callbackAt: collected.callback_time?.value,
    // What the lead asked for (e.g. "Hair transplant") → the lead's tag (§3.1).
    // Accept whichever data-collection key the agent uses for the service/ask.
    tag:
      collected.tag?.value ??
      collected.requested_service?.value ??
      collected.service?.value ??
      collected.interest?.value,
    // AI→human handover signals (§3.1).
    handoverReasons: collectHandoverReasons(collected),
    cqs: cqs != null && !Number.isNaN(cqs) ? cqs : undefined,
    language: collected.language?.value,
  };
}
