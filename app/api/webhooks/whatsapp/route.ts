// WhatsApp Business Cloud API webhook. (§3.1.3, §3.1.10, §3.1.13)
//   GET  → subscription verification handshake (hub.challenge).
//   POST → inbound messages + delivery statuses: verify the X-Hub-Signature-256
//          (signed with the Meta app secret — same app as Lead Ads), then parse.
//
// For now this parses + logs inbound messages and flags opt-out ("STOP") and
// consent ("YES") keywords. Persisting opt-out and wiring the consent/fallback
// flows is the next step.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyMetaSignature } from "@/lib/providers/meta";
import { optOutLeadsByPhone } from "@/lib/leadIntake";
import { findLeadByPhone, findOrCreateLeadByPhone, recordInbound, updateMessageStatus } from "@/lib/messages";
import { stopEnrollmentForLead } from "@/lib/campaigns/engine";
import { runChatbot } from "@/lib/chatbotRuntime";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { logger } from "@/lib/logger";

const OPT_OUT_KEYWORDS = ["stop", "stop messages", "unsubscribe"];
const CONSENT_KEYWORDS = ["yes", "y"];

// Flatten a WhatsApp inbound message into a storable + routable shape. For button /
// list replies we also surface the reply id + title so the chatbot can branch.
function parseInbound(msg: any): {
  type: string;
  body: string;
  mediaId?: string;
  interactiveId?: string;
  interactiveTitle?: string;
} {
  const type: string = msg.type ?? "text";
  switch (type) {
    case "text":
      return { type, body: msg.text?.body ?? "" };
    case "button":
      return { type, body: msg.button?.text ?? "", interactiveId: msg.button?.payload, interactiveTitle: msg.button?.text };
    case "interactive": {
      const br = msg.interactive?.button_reply;
      const lr = msg.interactive?.list_reply;
      const title = br?.title ?? lr?.title ?? "";
      return { type, body: title, interactiveId: br?.id ?? lr?.id, interactiveTitle: title };
    }
    case "image":
      return { type, body: msg.image?.caption ?? "[image]", mediaId: msg.image?.id };
    case "document":
      return { type, body: msg.document?.caption ?? msg.document?.filename ?? "[document]", mediaId: msg.document?.id };
    case "audio":
      return { type, body: "[audio]", mediaId: msg.audio?.id };
    case "video":
      return { type, body: msg.video?.caption ?? "[video]", mediaId: msg.video?.id };
    default:
      return { type, body: `[${type}]` };
  }
}

// The sender's WhatsApp profile name, matched by wa_id from the webhook's
// `contacts` array (used to name an auto-created lead).
function contactName(value: any, waId: string): string | undefined {
  const c = (value?.contacts ?? []).find((x: any) => x?.wa_id === waId);
  return c?.profile?.name;
}

// Best-effort Slack ping when a patient replies, so an agent can pick it up.
async function notifyInbound(leadId: string, leadName: string, snippet: string) {
  if (!isSlackConfigured()) return;
  const base = process.env.NEXTAUTH_URL;
  const link = base ? ` <${base}/leads/${leadId}|Open chat>` : "";
  await sendSlack({ text: `💬 WhatsApp from *${leadName}*: "${snippet.slice(0, 140)}"${link}` });
}

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
          const { type, body, mediaId, interactiveId, interactiveTitle } = parseInbound(msg);
          const norm = body.trim().toLowerCase();

          // Dedup chatbot execution across Meta's webhook retries: if we've already
          // stored this message id, don't re-run the flow (it would double-reply).
          const alreadySeen = msg.id
            ? await prisma.message.findUnique({ where: { waId: msg.id }, select: { id: true } })
            : null;

          // Opt-out keyword (§3.1.10): suppress all outreach for this number.
          if (OPT_OUT_KEYWORDS.includes(norm)) {
            const n = await optOutLeadsByPhone(from, `WhatsApp opt-out ("${body}")`);
            logger.warn(`WhatsApp OPT-OUT from ${from}: "${body}" — suppressed ${n} lead(s)`);
          } else if (CONSENT_KEYWORDS.includes(norm)) {
            logger.info(`WhatsApp CONSENT "YES" from ${from} (TODO: confirm + trigger call)`);
          }

          // Persist the reply on the lead's thread. Primary flow: we reached out
          // → they reply → match an existing lead. A cold inbound from an unknown
          // number auto-creates a lead (manual_followup, no AI call) — except a
          // bare "STOP", which we only apply to existing leads, never create one.
          const isOptOut = OPT_OUT_KEYWORDS.includes(norm);
          const lead = isOptOut
            ? await findLeadByPhone(from)
            : (await findOrCreateLeadByPhone(from, contactName(value, from))).lead;
          if (lead) {
            await recordInbound({ leadId: lead.id, waId: msg.id, type, body, mediaId });
            await notifyInbound(lead.id, lead.name, body);
            logger.info(`WhatsApp inbound stored for lead ${lead.id} (${type})`);

            // Reply-stops-everything (§follow-up): the instant a lead replies, halt any
            // active follow-up campaign — a human takes over; the system must never talk
            // over a real conversation. Runs for a plain reply AND an opt-out.
            await stopEnrollmentForLead(lead.id, isOptOut ? "opted_out" : "replied");

            // Drive the chatbot flow — but not for opt-out messages, and only once
            // per message id (dedup above), so retries don't double-fire.
            if (!isOptOut && !alreadySeen) {
              await runChatbot(lead.id, { text: body, interactiveId, interactiveTitle });
            }
          } else {
            logger.warn(`WhatsApp opt-out from unknown number ${from} — nothing to suppress`);
          }
        }

        for (const st of value.statuses ?? []) {
          // Link the delivery receipt back to the outbound message we logged.
          if (st.id && st.status) {
            await updateMessageStatus(st.id, st.status, st.errors?.[0]?.title);
          }
        }
      }
    }
  } catch (err) {
    // Never 500 back to Meta (it would retry endlessly) — log and ack.
    logger.error(`WhatsApp webhook processing error: ${String(err)}`);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
