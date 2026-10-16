// Razorpay → CRM: a payment happened (§3, 3.4). Server-to-server, so it arrives even when
// the patient closed the tab before the checkout callback could fire — which used to leave
// a paid-for hold to lapse with nobody knowing.
//
// Verified with X-Razorpay-Signature over the RAW body (RAZORPAY_WEBHOOK_SECRET, set in the
// Razorpay dashboard with the events `payment.captured` and `order.paid`). Idempotent: the
// browser callback and this webhook both arriving is the normal case. Always answers 200
// once verified, so Razorpay doesn't retry something we have already decided about.
import { NextResponse } from "next/server";
import { verifyRazorpayWebhook } from "@/lib/providers/razorpay";
import { onRazorpayPaid } from "@/lib/scheduling/online";
import { logger } from "@/lib/logger";

type Payload = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string } };
    order?: { entity?: { id?: string } };
  };
};

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyRazorpayWebhook(raw, req.headers.get("x-razorpay-signature"))) {
    logger.warn("Razorpay webhook: bad signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }
  let body: Payload;
  try {
    body = JSON.parse(raw) as Payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.event !== "payment.captured" && body.event !== "order.paid") {
    return NextResponse.json({ ok: true, ignored: body.event ?? null });
  }
  const payment = body.payload?.payment?.entity;
  const orderId = payment?.order_id ?? body.payload?.order?.entity?.id;
  if (!orderId || !payment?.id) return NextResponse.json({ ok: true, ignored: "no order/payment id" });
  const outcome = await onRazorpayPaid(orderId, payment.id);
  logger.info(`Razorpay webhook ${body.event} for ${orderId}: ${outcome}`);
  return NextResponse.json({ ok: true, outcome });
}
