// Zod schemas for every webhook/API boundary. (Guide §2.2, §7, §9)
// Validate ALL inbound payloads before touching the database.
import { z } from "zod";

export const leadSourceEnum = z.enum([
  "web_form",
  "referral",
  "manual",
  "walk_in",
  "facebook",
  "instagram",
  "google",
  "whatsapp",
]);

/// Walk-in / front-desk entry (§3.1.1, §3.1.13). Consent (iPad or written) is
/// collected at the clinic and is MANDATORY — per spec the record is not created
/// without it. No AI call is ever triggered for walk-ins (§3.1.2 exceptions).
export const walkInSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  email: z.string().email().optional(),
  interest: z.string().optional(),
  consentMethod: z.enum(["ipad", "written"]),
});
export type WalkInInput = z.infer<typeof walkInSchema>;

/// POST /api/leads  — create a lead (also used by the lead-created webhook body).
export const createLeadSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5), // E.164 expected, e.g. +919876543210
  email: z.string().email().optional(),
  interest: z.string().optional(),
  source: leadSourceEnum.optional(),
  externalId: z.string().optional(),
  campaign: z.string().optional(),
  adId: z.string().optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/// Public website contact form. No shared secret (public), so it carries a
/// honeypot field that bots tend to fill — a non-empty value means "drop it".
export const webFormSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  email: z.string().email().optional(),
  interest: z.string().optional(),
  // Honeypot — real users never see/fill this; a non-empty value = bot.
  // Accepted by the schema so the handler can silently drop it.
  company: z.string().optional(),
});

/// Meta (Facebook/Instagram) leadgen webhook notification. (Graph API)
/// We only need the leadgen_id + ad context; full contact data is fetched
/// from the Graph API afterwards.
export const metaLeadgenWebhookSchema = z.object({
  object: z.literal("page"),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().optional(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            leadgen_id: z.string(),
            page_id: z.string().optional(),
            form_id: z.string().optional(),
            ad_id: z.string().optional(),
            adgroup_id: z.string().optional(),
            created_time: z.number().optional(),
          }),
        }),
      ),
    }),
  ),
});

/// Google Ads Lead Form webhook payload.
export const googleLeadFormSchema = z.object({
  lead_id: z.string(),
  api_version: z.string().optional(),
  form_id: z.union([z.string(), z.number()]).optional(),
  campaign_id: z.union([z.string(), z.number()]).optional(),
  adgroup_id: z.union([z.string(), z.number()]).optional(),
  creative_id: z.union([z.string(), z.number()]).optional(),
  gcl_id: z.string().optional(),
  google_key: z.string(), // shared key configured in the Google Ads form
  is_test: z.boolean().optional(),
  user_column_data: z.array(
    z.object({
      column_id: z.string(),
      string_value: z.string().optional(),
      column_name: z.string().optional(),
    }),
  ),
});

/// ElevenLabs Conversational AI post-call webhook ("post_call_transcription").
/// Lenient: ElevenLabs adds fields over time, so unknown keys pass through.
/// `dynamic_variables` round-trips the lead_id/call_type we set when dialing.
const dataCollectionItem = z.object({ value: z.string().optional() }).passthrough();

export const elevenLabsPostCallSchema = z
  .object({
    type: z.string().optional(), // "post_call_transcription"
    event_timestamp: z.number().optional(),
    data: z
      .object({
        agent_id: z.string().optional(),
        conversation_id: z.string().optional(),
        status: z.string().optional(),
        transcript: z
          .array(
            z
              .object({ role: z.string(), message: z.string().nullish() })
              .passthrough(),
          )
          .optional(),
        metadata: z
          .object({ call_duration_secs: z.number().int().nonnegative().optional() })
          .passthrough()
          .optional(),
        analysis: z
          .object({
            transcript_summary: z.string().optional(),
            call_successful: z.string().optional(), // success | failure | unknown
            data_collection_results: z.record(z.string(), dataCollectionItem).optional(),
          })
          .passthrough()
          .optional(),
        conversation_initiation_client_data: z
          .object({
            dynamic_variables: z.record(z.string(), z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

/// n8n Agent 2 → Your Software, writing call data back to the CRM. (Guide §7.3)
export const writeCallSchema = z.object({
  leadId: z.string(),
  callType: z.enum(["initial", "reconfirmation"]),
  elevenlabsId: z.string().optional(),
  transcript: z.string().optional(),
  outcome: z.enum(["confirmed", "no_answer", "rescheduled", "not_interested"]).optional(),
  sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
  duration: z.number().int().nonnegative().optional(),
  /// ISO datetime the lead asked to be called back (§3.1.2). When present we
  /// cancel remaining auto-retries and schedule a call at this time.
  callbackAt: z.string().optional(),
  /// What the lead asked for in the call (e.g. "Hair transplant") — stored as
  /// the lead's tag. Staff can override it in the dashboard afterwards.
  tag: z.string().optional(),
  /// AI→human handover signals (§3.1). `handoverReasons` are trigger keys the
  /// agent/scoring model flagged; `cqs` (0–100) and `language` drive the
  /// threshold-based triggers we evaluate server-side.
  handoverReasons: z.array(z.string()).optional(),
  cqs: z.number().min(0).max(100).optional(),
  language: z.string().optional(),
});
export type WriteCallInput = z.infer<typeof writeCallSchema>;

/// Map a call outcome to the lead's pipeline status. (Guide §6.1)
export function statusFromOutcome(outcome?: string): string {
  switch (outcome) {
    case "confirmed":
      return "confirmed";
    case "rescheduled":
      return "rescheduled";
    case "not_interested":
      return "not_interested";
    default:
      return "called";
  }
}
