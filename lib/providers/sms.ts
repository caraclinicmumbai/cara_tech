// SMS (§3.2 2.4 fallback channel) over Plivo — already our telephony provider, and it
// handles India's DLT rules. Under TRAI's DLT framework every commercial SMS must carry
// a registered sender header, the clinic's DLT entity id and the id of the exact
// registered template; an SMS without them is dropped by the operator. So this stays
// switched off until all three exist (the clinic's registration — 2.4.d, Jatin).
//
//   PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN  — the existing account
//   PLIVO_SMS_SENDER                  — the DLT-approved sender header, e.g. "CARACL"
//   PLIVO_DLT_ENTITY_ID               — the clinic's DLT principal entity id
//   + a per-template DLT template id (AppointmentMessageTemplate.smsDltTemplateId)
import { dialablePhone } from "@/lib/phone";
import { logger } from "@/lib/logger";

export function isSmsConfigured(): boolean {
  return !!(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN && process.env.PLIVO_SMS_SENDER && process.env.PLIVO_DLT_ENTITY_ID);
}

export type SmsResult = { ok: true; ref: string } | { ok: false; error: string };

export async function sendSms(to: string, text: string, dltTemplateId: string | null | undefined): Promise<SmsResult> {
  if (!isSmsConfigured()) return { ok: false, error: "SMS not configured (DLT registration pending)" };
  if (!dltTemplateId) return { ok: false, error: "No DLT template id for this message" };
  const dst = dialablePhone(to);
  if (!dst) return { ok: false, error: `Can't text ${to}` };
  const id = process.env.PLIVO_AUTH_ID!;
  try {
    const res = await fetch(`https://api.plivo.com/v1/Account/${id}/Message/`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${process.env.PLIVO_AUTH_TOKEN}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        src: process.env.PLIVO_SMS_SENDER,
        dst: dst.replace(/^\+/, ""),
        text,
        dlt_entity_id: process.env.PLIVO_DLT_ENTITY_ID,
        dlt_template_id: dltTemplateId,
        dlt_template_category: "service_implicit",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { message_uuid?: string[]; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `Plivo SMS ${res.status}` };
    return { ok: true, ref: body.message_uuid?.[0] ?? "" };
  } catch (err) {
    logger.error(`SMS to ${dst} failed: ${String(err)}`);
    return { ok: false, error: "SMS request failed" };
  }
}
