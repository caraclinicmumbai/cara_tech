// Google Ads Lead Form adapter.
// Google POSTs a JSON payload directly to the configured webhook URL, including
// a shared `google_key` for validation and a `user_column_data` array.
// Docs: https://support.google.com/google-ads/answer/7features (Lead form webhook)
import { timingSafeEqual } from "crypto";
import type { NormalizedLead } from "@/lib/leadIntake";
import type { z } from "zod";
import type { googleLeadFormSchema } from "@/lib/contracts";

type GooglePayload = z.infer<typeof googleLeadFormSchema>;

/// Constant-time comparison of the payload's google_key with our configured key.
export function verifyGoogleKey(key: string): boolean {
  const expected = process.env.GOOGLE_LEADFORM_KEY;
  if (!expected) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pick(cols: Record<string, string>, ...ids: string[]): string | undefined {
  for (const id of ids) if (cols[id]) return cols[id];
  return undefined;
}

/// Map a Google lead-form payload to a NormalizedLead.
export function mapGoogleLead(payload: GooglePayload): NormalizedLead {
  const cols: Record<string, string> = {};
  for (const c of payload.user_column_data) {
    if (c.string_value != null) cols[c.column_id.toUpperCase()] = c.string_value;
  }

  const name =
    pick(cols, "FULL_NAME", "NAME") ??
    [pick(cols, "FIRST_NAME"), pick(cols, "LAST_NAME")].filter(Boolean).join(" ").trim();

  return {
    name: name || "Unknown",
    phone: pick(cols, "PHONE_NUMBER", "PHONE", "WORK_PHONE") ?? "",
    email: pick(cols, "EMAIL", "USER_EMAIL", "WORK_EMAIL"),
    interest: pick(cols, "INTEREST", "SERVICE", "TREATMENT"),
    source: "google",
    externalId: payload.lead_id,
    campaign: payload.campaign_id != null ? String(payload.campaign_id) : undefined,
    adId: payload.adgroup_id != null ? String(payload.adgroup_id) : undefined,
  };
}
