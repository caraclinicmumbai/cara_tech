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
