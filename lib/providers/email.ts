// Email (§3.2 2.4 — surgery instructions go by email in parallel) over AWS SES (v2),
// decided 2026-10-08. Off until configured:
//   SES_REGION, SES_FROM_EMAIL (a verified sender, e.g. appointments@caraclinics.com)
//   SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY — optional; without them the default AWS
//   credential chain is used.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { logger } from "@/lib/logger";

let client: SESv2Client | null = null;

export function isEmailConfigured(): boolean {
  return !!(process.env.SES_REGION && process.env.SES_FROM_EMAIL);
}

function ses(): SESv2Client {
  if (!client) {
    const key = process.env.SES_ACCESS_KEY_ID?.trim();
    const secret = process.env.SES_SECRET_ACCESS_KEY?.trim();
    client = new SESv2Client({
      region: process.env.SES_REGION,
      ...(key && secret ? { credentials: { accessKeyId: key, secretAccessKey: secret } } : {}),
    });
  }
  return client;
}

export type EmailResult = { ok: true; ref: string } | { ok: false; error: string };

export async function sendEmail(to: string, subject: string, text: string): Promise<EmailResult> {
  if (!isEmailConfigured()) return { ok: false, error: "Email not configured" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: "No valid email address" };
  try {
    const out = await ses().send(
      new SendEmailCommand({
        FromEmailAddress: process.env.SES_FROM_EMAIL,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    );
    return { ok: true, ref: out.MessageId ?? "" };
  } catch (err) {
    logger.error(`Email to ${to} failed: ${String(err)}`);
    return { ok: false, error: "Email send failed" };
  }
}
