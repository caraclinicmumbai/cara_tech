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
};

type GraphComponent = { type?: string; text?: string };
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
        return {
          name: t.name,
          language: t.language,
          category: t.category ?? "",
          bodyText: body,
          paramCount: countParams(body),
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
  const clean = params.map((p) => p.trim()).filter((p) => p.length > 0);
  if (clean.length === 0) return undefined;
  return [{ type: "body", parameters: clean.map((text) => ({ type: "text", text })) }];
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

export type CreateTemplateInput = {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY";
  header?: string; // static text header (optional)
  body: string; // required; may contain {{1}}..{{n}}
  bodyExamples?: string[]; // example values for the body vars, in order (Meta requires these)
  footer?: string;
};

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
  if (input.header?.trim()) {
    components.push({ type: "HEADER", format: "TEXT", text: input.header.trim() });
  }
  const bodyComp: Record<string, unknown> = { type: "BODY", text: body };
  if (varCount > 0) bodyComp.example = { body_text: [examples.slice(0, varCount)] };
  components.push(bodyComp);
  if (input.footer?.trim()) components.push({ type: "FOOTER", text: input.footer.trim() });

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
