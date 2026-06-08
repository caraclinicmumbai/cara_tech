// n8n trigger helpers. (Guide §5: lib/n8n.ts)
// Your software → n8n Agent 1 (Outbound Call). Contract: Guide §7.1.
import axios from "axios";

export type NewLeadWebhookPayload = {
  leadId: string;
  name: string;
  phone: string;
  interest?: string;
  source?: string;
  /// Optional context for a re-confirmation (second) call.
  context?: string;
  callType?: "initial" | "reconfirmation";
};

/// Fire the "new lead" webhook to n8n Agent 1, which formats the payload and
/// calls the ElevenLabs API to place the outbound voice call.
export async function triggerOutboundCall(payload: NewLeadWebhookPayload) {
  const url = process.env.N8N_WEBHOOK_NEW_LEAD;
  if (!url) throw new Error("N8N_WEBHOOK_NEW_LEAD is not configured");

  const res = await axios.post(url, payload, {
    headers: {
      "Content-Type": "application/json",
      ...(process.env.N8N_API_KEY ? { "X-N8N-API-KEY": process.env.N8N_API_KEY } : {}),
    },
    timeout: 15_000,
  });
  return res.data;
}
