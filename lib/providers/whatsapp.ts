// WhatsApp Business Cloud API sender (Meta, direct). (§3.1.3 / §3.1.13)
// Sends via the Graph API: POST /{phone_number_id}/messages with a bearer token
// that has whatsapp_business_messaging permission.
//
// WhatsApp messaging rules:
//   - Business-INITIATED messages (proactive, outside the 24h window) MUST use a
//     pre-approved TEMPLATE → sendWhatsAppTemplate().
//   - Inside the 24h customer-service window (lead messaged us recently) we may
//     send free-form text → sendWhatsAppText().
//
// Fail-safe: logs and returns false on misconfig/error; never throws, so a
// notification can't break the flow that triggered it.
import axios from "axios";
import { logger } from "@/lib/logger";

const GRAPH = "https://graph.facebook.com";

function graphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? "v21.0";
}

export function isWhatsAppConfigured(): boolean {
  return !!process.env.WHATSAPP_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID;
}

/// WhatsApp wants the full international number in digits (country code, no '+').
function normalizeNumber(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export type WhatsAppSendResult =
  | { ok: true; waId: string }
  | { ok: false; error: string };

async function postMessage(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    logger.warn("WhatsApp not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID) — skipping send");
    return { ok: false, error: "WhatsApp not configured" };
  }

  try {
    const res = await axios.post(
      `${GRAPH}/${graphVersion()}/${phoneId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", ...payload },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15_000 },
    );
    const id = res.data?.messages?.[0]?.id;
    if (!id) {
      logger.error(`WhatsApp send returned no message id: ${JSON.stringify(res.data)}`);
      return { ok: false, error: "No message id returned" };
    }
    return { ok: true, waId: id };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    logger.error(`WhatsApp send failed: ${detail}`);
    return { ok: false, error: detail };
  }
}

/// Send an APPROVED template message (business-initiated / outside 24h window).
/// `components` lets you fill template variables; omit for static templates
/// like the pre-approved "hello_world".
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode = "en_US",
  components?: unknown[],
): Promise<WhatsAppSendResult> {
  return postMessage({
    to: normalizeNumber(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  });
}

/// Send free-form text — ONLY valid inside the 24h customer-service window
/// (i.e. the lead messaged us within the last 24h). Otherwise Meta rejects it.
export async function sendWhatsAppText(to: string, body: string): Promise<WhatsAppSendResult> {
  return postMessage({ to: normalizeNumber(to), type: "text", text: { preview_url: false, body } });
}
