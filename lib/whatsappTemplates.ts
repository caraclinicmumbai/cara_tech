// Lists APPROVED WhatsApp message templates from the WABA (§3.1.3, Phase 2).
// Used to re-open a closed 24h window: outside the window only a pre-approved
// template may be sent, so the agent picks one from here.
//
// Templates are fetched from the Graph API on demand (small, ~dozens). Returns
// an empty list (never throws) when the WABA isn't configured yet.
import axios from "axios";
import { logger } from "@/lib/logger";

const GRAPH = "https://graph.facebook.com";

function graphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? "v21.0";
}

export type WhatsAppTemplate = {
  name: string;
  language: string;
  category: string;
  /// The BODY text (with {{1}} placeholders), for preview.
  bodyText: string;
  /// How many {{n}} body parameters the agent must fill before sending.
  paramCount: number;
  /// The header's format, when it has one: TEXT | IMAGE | VIDEO | DOCUMENT.
  headerFormat: string | null;
  /// True when the header is a FILE the sender must supply (image/video/document).
  /// Such a template can't be sent from a chat composer — Meta rejects it with
  /// "Format mismatch, expected DOCUMENT, received UNKNOWN" unless the media is
  /// attached. Those sends have their own paths (a quote PDF goes out from the
  /// lead's Quotes panel, which uploads the file first).
  requiresMedia: boolean;
};

type GraphComponent = { type?: string; text?: string; format?: string };
type GraphTemplate = {
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: GraphComponent[];
};

/// Count distinct {{1}}, {{2}}… placeholders in a template body.
function countParams(text: string): number {
  const nums = new Set<number>();
  for (const m of text.matchAll(/\{\{(\d+)\}\}/g)) nums.add(Number(m[1]));
  return nums.size;
}

/// Fetch APPROVED templates for the configured WABA. Empty list on misconfig/error.
export async function listApprovedTemplates(): Promise<WhatsAppTemplate[]> {
  const token = process.env.WHATSAPP_TOKEN;
  const wabaId = process.env.WHATSAPP_WABA_ID;
  if (!token || !wabaId) {
    logger.warn("WhatsApp templates: WHATSAPP_TOKEN / WHATSAPP_WABA_ID not set — returning none");
    return [];
  }

  try {
    const res = await axios.get(`${GRAPH}/${graphVersion()}/${wabaId}/message_templates`, {
      params: { fields: "name,language,status,category,components", limit: 200 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    const data: GraphTemplate[] = res.data?.data ?? [];
    return data
      .filter((t) => t.status === "APPROVED")
      .map((t) => {
        const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
        const header = t.components?.find((c) => c.type === "HEADER");
        const headerFormat = header?.format?.toUpperCase() ?? null;
        return {
          name: t.name,
          language: t.language,
          category: t.category ?? "",
          bodyText: body,
          paramCount: countParams(body),
          headerFormat,
          requiresMedia: !!headerFormat && headerFormat !== "TEXT",
        };
      });
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    logger.error(`WhatsApp templates fetch failed: ${detail}`);
    return [];
  }
}

/// Build the Graph `components` array for a template send from body parameter
/// values (in order). Returns undefined when there are no parameters.
export function buildTemplateComponents(params: string[]): unknown[] | undefined {
  const clean = params.map((p) => p.trim());
  // Nothing to fill → a static template. Otherwise keep every slot IN POSITION:
  // dropping a blank would shift {{2}}'s value into {{1}} and send the patient a
  // scrambled message. Meta rejects a blank parameter loudly, which is what we want.
  if (clean.every((p) => p.length === 0)) return undefined;
  return [{ type: "body", parameters: clean.map((text) => ({ type: "text", text })) }];
}

/// Pull the body parameter values back out of a Graph `components` array — the
/// inverse of buildTemplateComponents. Used to render what the patient actually
/// received when logging a template send to the thread.
export function extractBodyParams(components?: unknown[]): string[] {
  if (!Array.isArray(components)) return [];
  for (const c of components) {
    const comp = c as { type?: string; parameters?: { type?: string; text?: string }[] };
    if (comp?.type?.toLowerCase() !== "body") continue;
    return (comp.parameters ?? []).map((p) => p?.text ?? "");
  }
  return [];
}

/// Substitute {{1}}, {{2}}… in a template body with the given values (in order).
/// Placeholders with no value are left intact so the gap is visible.
export function fillTemplateBody(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => {
    const v = params[Number(n) - 1];
    return v && v.trim() ? v : whole;
  });
}

// The approved-template list changes rarely (a Meta review cycle takes hours),
// but we read it on every template send to render the message text. Cache it in
// module memory for a few minutes so a chatbot burst isn't N Graph calls.
const TEMPLATE_CACHE_MS = 5 * 60_000;
let templateCache: { at: number; items: WhatsAppTemplate[] } | null = null;

/// listApprovedTemplates() with a short in-process cache.
export async function listApprovedTemplatesCached(): Promise<WhatsAppTemplate[]> {
  const now = Date.now();
  if (templateCache && now - templateCache.at < TEMPLATE_CACHE_MS) return templateCache.items;
  const items = await listApprovedTemplates();
  // Don't cache an empty list from a failed/misconfigured fetch — retry next time.
  if (items.length > 0) templateCache = { at: now, items };
  return items;
}

/// Render the text a template send actually delivers: the approved BODY with its
/// {{n}} placeholders filled in. Null when the template can't be resolved (WABA
/// not configured, Graph error, template not approved) — callers fall back to
/// naming the template.
export async function renderTemplateBody(
  templateName: string,
  languageCode: string | undefined,
  params: string[],
): Promise<string | null> {
  const all = await listApprovedTemplatesCached();
  const match =
    all.find((t) => t.name === templateName && t.language === languageCode) ??
    all.find((t) => t.name === templateName);
  if (!match?.bodyText) return null;
  return fillTemplateBody(match.bodyText, params);
}

// ── Template management (create + list all statuses) ─────────────────

export type TemplateStatus = "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED";

export type WhatsAppTemplateRow = {
  name: string;
  language: string;
  category: string;
  status: TemplateStatus | string;
  bodyText: string;
};

/// List ALL templates (any status) for the management screen.
export async function listAllTemplates(): Promise<WhatsAppTemplateRow[]> {
  const token = process.env.WHATSAPP_TOKEN;
  const wabaId = process.env.WHATSAPP_WABA_ID;
  if (!token || !wabaId) return [];
  try {
    const res = await axios.get(`${GRAPH}/${graphVersion()}/${wabaId}/message_templates`, {
      params: { fields: "name,language,status,category,components", limit: 200 },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    const data: GraphTemplate[] = res.data?.data ?? [];
    return data.map((t) => ({
      name: t.name,
      language: t.language,
      category: t.category ?? "",
      status: t.status,
      bodyText: t.components?.find((c) => c.type === "BODY")?.text ?? "",
    }));
  } catch (err) {
    const detail = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? err.message) : String(err);
    logger.error(`WhatsApp listAllTemplates failed: ${detail}`);
    return [];
  }
}

/// A template call-to-action / quick-reply button (§template builder).
export type TemplateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phone_number: string };

export type HeaderFormat = "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

export type CreateTemplateInput = {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  header?: string; // static TEXT header (optional)
  headerFormat?: HeaderFormat; // TEXT (uses `header`) or a media format (uses `headerHandle`)
  headerHandle?: string; // resumable-upload handle for a media header (see uploadSampleMedia)
  body: string; // required; may contain {{1}}..{{n}}
  bodyExamples?: string[]; // example values for the body vars, in order (Meta requires these)
  footer?: string;
  buttons?: TemplateButton[]; // quick-reply / URL / phone buttons (optional)
};

/// Upload a SAMPLE media file to Meta's resumable-upload API and return its
/// `header_handle` — required to create an IMAGE/VIDEO/DOCUMENT-header template.
/// Two steps: create an upload session, then upload the bytes. Needs META_APP_ID.
export async function uploadSampleMedia(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<{ ok: true; handle: string } | { ok: false; error: string }> {
  const token = process.env.WHATSAPP_TOKEN;
  const appId = process.env.META_APP_ID;
  if (!token) return { ok: false, error: "WhatsApp token not configured" };
  if (!appId) return { ok: false, error: "META_APP_ID not set — add your Meta App ID to enable media headers" };

  try {
    // Step 1 — create an upload session.
    const session = await axios.post(`${GRAPH}/${graphVersion()}/${appId}/uploads`, null, {
      params: { file_name: filename, file_length: buffer.length, file_type: mime },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20_000,
    });
    const sessionId: string | undefined = session.data?.id;
    if (!sessionId) return { ok: false, error: "No upload session id returned" };

    // Step 2 — upload the bytes; response carries the file handle `h`.
    const up = await axios.post(`${GRAPH}/${graphVersion()}/${sessionId}`, buffer, {
      headers: { Authorization: `OAuth ${token}`, file_offset: "0", "Content-Type": "application/octet-stream" },
      maxBodyLength: Infinity,
      timeout: 60_000,
    });
    const handle: string | undefined = up.data?.h;
    if (!handle) return { ok: false, error: "No file handle returned from upload" };
    return { ok: true, handle };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data?.error?.error_user_msg ?? err.response?.data?.error?.message ?? JSON.stringify(err.response?.data ?? err.message))
      : String(err);
    logger.error(`WhatsApp uploadSampleMedia failed: ${detail}`);
    return { ok: false, error: String(detail) };
  }
}

export type CreateTemplateResult =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string };

/// Submit a new template to Meta for review. Returns the new template id +
/// status (usually PENDING). Validates name + required examples client-and-server.
export async function createTemplate(input: CreateTemplateInput): Promise<CreateTemplateResult> {
  const token = process.env.WHATSAPP_TOKEN;
  const wabaId = process.env.WHATSAPP_WABA_ID;
  if (!token || !wabaId) return { ok: false, error: "WhatsApp WABA not configured" };

  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    return { ok: false, error: "Name must be lowercase letters, numbers, and underscores only" };
  }
  const body = input.body.trim();
  if (!body) return { ok: false, error: "Body text is required" };

  const varCount = countParams(body);
  const examples = (input.bodyExamples ?? []).map((s) => s.trim());
  if (varCount > 0 && examples.filter(Boolean).length < varCount) {
    return { ok: false, error: `Provide an example value for each of the ${varCount} variable(s)` };
  }

  const components: Record<string, unknown>[] = [];
  // Header: a media header (uses the resumable-upload handle) or a plain TEXT header.
  if (input.headerFormat && input.headerFormat !== "TEXT") {
    if (!input.headerHandle) return { ok: false, error: "Upload a sample file for the media header" };
    components.push({ type: "HEADER", format: input.headerFormat, example: { header_handle: [input.headerHandle] } });
  } else if (input.header?.trim()) {
    components.push({ type: "HEADER", format: "TEXT", text: input.header.trim() });
  }
  const bodyComp: Record<string, unknown> = { type: "BODY", text: body };
  if (varCount > 0) bodyComp.example = { body_text: [examples.slice(0, varCount)] };
  components.push(bodyComp);
  if (input.footer?.trim()) components.push({ type: "FOOTER", text: input.footer.trim() });

  // Buttons (quick-reply / URL / phone). Meta validates the exact mix + limits on
  // submission; we do light per-button checks and let it surface the rest.
  const buttons = (input.buttons ?? []).filter((b) => b.text?.trim());
  if (buttons.length > 0) {
    for (const b of buttons) {
      if (b.type === "URL" && !b.url?.trim()) return { ok: false, error: `URL button "${b.text}" needs a URL` };
      if (b.type === "PHONE_NUMBER" && !b.phone_number?.trim())
        return { ok: false, error: `Call button "${b.text}" needs a phone number` };
    }
    components.push({
      type: "BUTTONS",
      buttons: buttons.map((b) => {
        const text = b.text.trim().slice(0, 25);
        if (b.type === "URL") return { type: "URL", text, url: b.url.trim() };
        if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text, phone_number: b.phone_number.trim() };
        return { type: "QUICK_REPLY", text };
      }),
    });
  }

  try {
    const res = await axios.post(
      `${GRAPH}/${graphVersion()}/${wabaId}/message_templates`,
      { name, language: input.language, category: input.category, components },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 20_000 },
    );
    return { ok: true, id: res.data?.id ?? "", status: res.data?.status ?? "PENDING" };
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? (err.response?.data?.error?.error_user_msg ?? err.response?.data?.error?.message ?? JSON.stringify(err.response?.data ?? err.message))
      : String(err);
    logger.error(`WhatsApp createTemplate failed: ${detail}`);
    return { ok: false, error: String(detail) };
  }
}

/// The approved template used to send a quote PDF proactively — i.e. when the 24h
/// window is shut and the only way to reach the patient is a template with the
/// document in its header (§quote lifecycle).
///
/// `QUOTE_DOC_TEMPLATE_NAME` pins it explicitly. With nothing set we ASK THE WABA:
/// an approved template with a DOCUMENT header is, by construction, the thing this
/// send needs. That's deliberate — the feature was silently disabled in production
/// for want of an env var while the right template sat approved in the account, and
/// an ops step nobody remembers is a worse design than a lookup.
///
/// Null when the WABA has no approved document template (or can't be reached), which
/// is what the UI reads to explain that the send isn't available.
export async function resolveQuoteDocTemplate(): Promise<{ name: string; lang: string } | null> {
  const pinned = process.env.QUOTE_DOC_TEMPLATE_NAME?.trim();
  if (pinned) {
    return { name: pinned, lang: process.env.QUOTE_DOC_TEMPLATE_LANG?.trim() || "en" };
  }

  const docTemplates = (await listApprovedTemplatesCached()).filter(
    (t) => t.headerFormat === "DOCUMENT",
  );
  if (docTemplates.length === 0) return null;
  if (docTemplates.length > 1) {
    // Ambiguous: pick deterministically (name order) and say so, rather than
    // silently sending whichever the Graph API happened to list first.
    const chosen = [...docTemplates].sort((a, b) => a.name.localeCompare(b.name))[0];
    logger.warn(
      `Several approved document templates (${docTemplates.map((t) => t.name).join(", ")}) — using "${chosen.name}". Set QUOTE_DOC_TEMPLATE_NAME to choose.`,
    );
    return { name: chosen.name, lang: chosen.language };
  }
  return { name: docTemplates[0].name, lang: docTemplates[0].language };
}
