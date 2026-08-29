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
    // The log keeps Meta's raw payload; the caller gets something a counsellor can act on.
    return { ok: false, error: humanGraphError(err) };
  }
}

/// Meta's send errors as a sentence, because the raw payload ends up in front of a
/// counsellor. `error_user_msg` is Meta's own patient-facing wording when present;
/// otherwise the codes worth naming are translated and anything else falls back to
/// the API's message.
export function humanGraphError(err: unknown): string {
  if (!axios.isAxiosError(err)) return String(err);
  const e = err.response?.data?.error as
    | { message?: string; code?: number; error_user_msg?: string; error_data?: { details?: string } }
    | undefined;
  if (!e) return err.message;
  if (e.error_user_msg) return e.error_user_msg;

  const details = e.error_data?.details ?? "";
  switch (e.code) {
    case 132012: // parameter format mismatch — nearly always a media header with no file
      return details.includes("expected")
        ? `This template needs a file attached to its header (${details}). Send it from the place that attaches the file — a quote goes out from the lead's Quotes panel.`
        : "The values don't match the shape this template was approved with.";
    case 132000:
      return "The number of variables doesn't match the approved template.";
    case 131047:
      return "The 24-hour window is closed for this patient — only an approved template can reopen it.";
    case 131026:
      return "That number can't receive WhatsApp messages.";
    case 131051:
      return "This message type isn't supported for that number.";
    case 130472:
      return "The patient is outside the experiment/audience Meta allows for this template.";
    default:
      return details ? `${e.message ?? "WhatsApp rejected the message"} — ${details}` : (e.message ?? "WhatsApp rejected the message");
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

/// Upload a document/media to Meta and return its media id (valid ~30 days). The
/// id is then referenced when sending a document message. Null on misconfig/error.
export async function uploadWhatsAppMedia(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<string | null> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    logger.warn("WhatsApp media upload: not configured — skipping");
    return null;
  }
  try {
    // form-data is a transitive dep (axios uses it); dynamic import keeps it off the
    // module top-level so client bundles never try to resolve it.
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", buffer, { filename, contentType: mime });
    const res = await axios.post(`${GRAPH}/${graphVersion()}/${phoneId}/media`, form, {
      headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
      timeout: 20_000,
      maxBodyLength: Infinity,
    });
    const id: string | undefined = res.data?.id;
    if (!id) {
      logger.error(`WhatsApp media upload returned no id: ${JSON.stringify(res.data)}`);
      return null;
    }
    return id;
  } catch (err) {
    const detail = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? err.message) : String(err);
    logger.error(`WhatsApp media upload failed: ${detail}`);
    return null;
  }
}

/// Send a previously-uploaded document (by media id) as a document message. Like
/// free text, this is a session message — valid only inside the 24h window.
export async function sendWhatsAppDocument(
  to: string,
  mediaId: string,
  filename: string,
  caption?: string,
): Promise<WhatsAppSendResult> {
  return postMessage({
    to: normalizeNumber(to),
    type: "document",
    document: { id: mediaId, filename, ...(caption ? { caption } : {}) },
  });
}

/// Send an uploaded document via an APPROVED template that has a document header —
/// the only way to push a document PROACTIVELY (outside the 24h window). The
/// template must be pre-approved in Meta WhatsApp Manager with a document header
/// and (optionally) {{1}}, {{2}}… body variables filled by `bodyParams`.
export async function sendWhatsAppDocumentTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  mediaId: string,
  filename: string,
  bodyParams: string[] = [],
): Promise<WhatsAppSendResult> {
  const components: unknown[] = [
    { type: "header", parameters: [{ type: "document", document: { id: mediaId, filename } }] },
  ];
  if (bodyParams.length) {
    components.push({ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) });
  }
  return postMessage({
    to: normalizeNumber(to),
    type: "template",
    template: { name: templateName, language: { code: languageCode }, components },
  });
}

/// Send interactive reply BUTTONS (max 3). Each button has a stable id we read back
/// from the tap to branch the chatbot flow. Session message → 24h window only.
export async function sendWhatsAppButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[],
): Promise<WhatsAppSendResult> {
  return postMessage({
    to: normalizeNumber(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/// Send an interactive LIST (single section). Rows carry stable ids read back on
/// selection. Session message → 24h window only.
export async function sendWhatsAppList(
  to: string,
  bodyText: string,
  buttonText: string,
  rows: { id: string; title: string; description?: string }[],
): Promise<WhatsAppSendResult> {
  return postMessage({
    to: normalizeNumber(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText.slice(0, 1024) },
      action: {
        button: (buttonText || "Choose").slice(0, 20),
        sections: [
          {
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          },
        ],
      },
    },
  });
}

/// Send an image by public link, with an optional caption. Session message.
export async function sendWhatsAppImageLink(
  to: string,
  link: string,
  caption?: string,
): Promise<WhatsAppSendResult> {
  return postMessage({
    to: normalizeNumber(to),
    type: "image",
    image: { link, ...(caption ? { caption } : {}) },
  });
}

// ── Inbound media (Phase 2) ──────────────────────────────────────────
// WhatsApp media arrives as an id; fetching it is two hops, both bearer-authed:
// 1) GET /{media_id} → a short-lived download URL + mime type.
// 2) GET that URL → the raw bytes.
// Meta expires media after ~30 days, so we proxy on demand rather than store.

export type WhatsAppMedia = { buffer: Buffer; mime: string };

/// Download an inbound media object by its Meta media id. Null on misconfig/error.
export async function fetchWhatsAppMedia(mediaId: string): Promise<WhatsAppMedia | null> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    logger.warn("WhatsApp media: WHATSAPP_TOKEN not set — cannot fetch");
    return null;
  }
  try {
    const meta = await axios.get(`${GRAPH}/${graphVersion()}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    const url: string | undefined = meta.data?.url;
    const mime: string = meta.data?.mime_type ?? "application/octet-stream";
    if (!url) {
      logger.error(`WhatsApp media ${mediaId}: no url in metadata`);
      return null;
    }
    const bin = await axios.get<ArrayBuffer>(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer",
      timeout: 20_000,
    });
    return { buffer: Buffer.from(bin.data), mime };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    logger.error(`WhatsApp media ${mediaId} fetch failed: ${detail}`);
    return null;
  }
}
