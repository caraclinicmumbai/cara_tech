// Meta (Facebook + Instagram) Lead Ads adapter.
// Flow: Meta POSTs a leadgen notification containing a leadgen_id (no PII).
// We verify the X-Hub-Signature-256 HMAC, then fetch the full lead from the
// Graph API using a Page access token, and map field_data → NormalizedLead.
// Docs: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
import { createHmac, timingSafeEqual } from "crypto";
import axios from "axios";
import type { NormalizedLead, LeadSource } from "@/lib/leadIntake";
import { logger } from "@/lib/logger";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";

/// Verify the HMAC-SHA256 signature Meta sends on every webhook POST.
/// `rawBody` MUST be the exact bytes received (not re-serialised JSON).
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !signatureHeader) return false;

  const expected =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

type GraphFieldDatum = { name: string; values: string[] };
type GraphLead = {
  id: string;
  field_data?: GraphFieldDatum[];
  ad_id?: string;
  form_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  platform?: string; // "fb" | "ig" | "facebook" | "instagram"
};

/// Fetch a single lead's full data from the Graph API.
export async function fetchMetaLead(leadgenId: string): Promise<GraphLead> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not configured");

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}`;
  const res = await axios.get<GraphLead>(url, {
    params: {
      access_token: token,
      fields: "field_data,ad_id,form_id,campaign_id,campaign_name,platform",
    },
    timeout: 15_000,
  });
  return res.data;
}

function pick(fields: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) if (fields[k]) return fields[k];
  return undefined;
}

/// Map a Graph lead (+ the ad_id from the webhook) to a NormalizedLead.
export function mapMetaLead(lead: GraphLead, fallbackAdId?: string): NormalizedLead {
  // field_data names are lowercased form-field keys; flatten to first value.
  const f: Record<string, string> = {};
  for (const fd of lead.field_data ?? []) {
    if (fd.values?.[0] != null) f[fd.name.toLowerCase()] = fd.values[0];
  }

  const name =
    pick(f, "full_name", "name") ??
    [pick(f, "first_name"), pick(f, "last_name")].filter(Boolean).join(" ").trim();

  const platform = (lead.platform ?? "").toLowerCase();
  const source: LeadSource = platform.startsWith("ig") || platform.includes("instagram")
    ? "instagram"
    : "facebook";

  return {
    name: name || "Unknown",
    phone: pick(f, "phone_number", "phone") ?? "",
    email: pick(f, "email"),
    interest: pick(f, "interest", "service", "treatment", "what_are_you_interested_in"),
    source,
    externalId: lead.id,
    campaign: lead.campaign_name ?? lead.campaign_id,
    adId: lead.ad_id ?? fallbackAdId,
  };
}

/// GET handshake: echo hub.challenge when the verify token matches.
export function handleMetaVerification(searchParams: URLSearchParams): {
  status: number;
  body: string;
} {
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.META_VERIFY_TOKEN) {
    return { status: 200, body: challenge ?? "" };
  }
  logger.warn("Meta webhook verification failed (bad mode/verify_token)");
  return { status: 403, body: "Forbidden" };
}
