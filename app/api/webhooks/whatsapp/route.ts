// WhatsApp Business Cloud API webhook. (§3.1.3, §3.1.10, §3.1.13)
//   GET  → subscription verification handshake (hub.challenge).
//   POST → inbound messages + delivery statuses: verify the X-Hub-Signature-256
//          (signed with the Meta app secret — same app as Lead Ads), then parse.
//
// For now this parses + logs inbound messages and flags opt-out ("STOP") and
// consent ("YES") keywords. Persisting opt-out and wiring the consent/fallback
// flows is the next step.
import { NextResponse } from "next/server";
import { verifyMetaSignature } from "@/lib/providers/meta";
import { optOutLeadsByPhone } from "@/lib/leadIntake";
import { logger } from "@/lib/logger";

const OPT_OUT_KEYWORDS = ["stop", "stop messages", "unsubscribe"];
const CONSENT_KEYWORDS = ["yes", "y"];

export function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  logger.warn("WhatsApp webhook verification failed (bad mode/verify_token)");
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};

        for (const msg of value.messages ?? []) {
          const from = msg.from;
          const text = (msg.text?.body ?? msg.button?.text ?? "").trim();
          const norm = text.toLowerCase();
          if (OPT_OUT_KEYWORDS.includes(norm)) {
            // Hard opt-out (§3.1.10): suppress all outreach for this number.
            const n = await optOutLeadsByPhone(from, `WhatsApp opt-out ("${text}")`);
            logger.warn(`WhatsApp OPT-OUT from ${from}: "${text}" — suppressed ${n} lead(s)`);
          } else if (CONSENT_KEYWORDS.includes(norm)) {
            logger.info(`WhatsApp CONSENT "YES" from ${from} (TODO: confirm + trigger call)`);
          } else {
            logger.info(`WhatsApp inbound from ${from} (${msg.type}): "${text.slice(0, 120)}"`);
          }
        }

        for (const st of value.statuses ?? []) {
          logger.info(`WhatsApp status ${st.status} for message ${st.id} → ${st.recipient_id}`);
        }
      }
    }
  } catch (err) {
    // Never 500 back to Meta (it would retry endlessly) — log and ack.
    logger.error(`WhatsApp webhook processing error: ${String(err)}`);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
