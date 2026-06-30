// Slack interactivity endpoint (§3.1). Handles the "Call & record" button on a
// handover alert: when a rep clicks it, Twilio rings THEIR phone, then dials the
// lead and records (lib/providers/twilio.clickToCall). Verified via the Slack
// signing secret (the route is public — Slack calls it — so the signature is the
// gate). Acks fast, then posts the result back via the message's response_url.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifySlackSignature } from "@/lib/slack";
import { clickToCall, isTwilioConfigured } from "@/lib/providers/twilio";
import { logger } from "@/lib/logger";

async function replyToSlack(responseUrl: string | undefined, text: string) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
  } catch (err) {
    logger.error(`Slack response_url post failed: ${String(err)}`);
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (
    !verifySlackSignature(
      raw,
      req.headers.get("x-slack-request-timestamp"),
      req.headers.get("x-slack-signature"),
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Slack posts application/x-www-form-urlencoded with payload=<json>.
  const payloadStr = new URLSearchParams(raw).get("payload");
  if (!payloadStr) return NextResponse.json({ ok: true });

  let payload: {
    actions?: { action_id?: string; value?: string }[];
    user?: { id?: string };
    response_url?: string;
  };
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const action = payload.actions?.[0];
  if (action?.action_id !== "call_and_record") return NextResponse.json({ ok: true });

  const leadId = action.value;
  const clickerId = payload.user?.id;
  const responseUrl = payload.response_url;

  // Do the work after acking (Slack wants a 200 within 3s); report via response_url.
  void (async () => {
    try {
      if (!isTwilioConfigured()) {
        await replyToSlack(responseUrl, "⚠️ Calling isn't configured yet.");
        return;
      }
      const rep = clickerId
        ? await prisma.salesRep.findFirst({ where: { slackUserId: clickerId } })
        : null;
      const lead = leadId
        ? await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } })
        : null;
      if (!rep?.phone) {
        await replyToSlack(responseUrl, "⚠️ No phone number on file for you — ask an admin to add it.");
        return;
      }
      if (!lead || !leadId) {
        await replyToSlack(responseUrl, "⚠️ Lead not found.");
        return;
      }
      const res = await clickToCall(rep.phone, leadId, rep.id);
      await replyToSlack(
        responseUrl,
        res.ok
          ? `📞 Calling you now on ${rep.phone} — answer, and we'll connect you to *${lead.name}*. The call is recorded.`
          : `⚠️ Couldn't start the call: ${res.error}`,
      );
      logger.info(`Slack call-and-record by ${clickerId} for lead ${leadId}: ${res.ok ? "started" : res.error}`);
    } catch (err) {
      logger.error(`Slack interact handler failed: ${String(err)}`);
      await replyToSlack(responseUrl, "⚠️ Something went wrong starting the call.");
    }
  })();

  return NextResponse.json({ ok: true });
}
