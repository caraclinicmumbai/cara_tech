// Razorpay (§2.3.b — pay for a consultation online, at a discount; decided 2026-10-08).
// Off until RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set. The browser opens
// Razorpay Checkout with an ORDER we create here, and the payment is only trusted after
// we verify Razorpay's signature over (order_id|payment_id) with our secret.
import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";

export function isRazorpayConfigured(): boolean {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function razorpayKeyId(): string {
  return process.env.RAZORPAY_KEY_ID ?? "";
}

export async function createRazorpayOrder(amountPaise: number, receipt: string, notes: Record<string, string>): Promise<{ ok: true; orderId: string } | { ok: false; error: string }> {
  if (!isRazorpayConfigured()) return { ok: false, error: "Online payment isn't available" };
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: receipt.slice(0, 40), notes }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
    if (!res.ok || !body.id) return { ok: false, error: body.error?.description ?? `Razorpay ${res.status}` };
    return { ok: true, orderId: body.id };
  } catch (err) {
    logger.error(`Razorpay order failed: ${String(err)}`);
    return { ok: false, error: "Payment service unreachable" };
  }
}

/// Razorpay Checkout's success handler returns these three; the signature is
/// HMAC-SHA256(order_id + "|" + payment_id, key_secret).
export function verifyRazorpayPayment(orderId: string, paymentId: string, signature: string): boolean {
  if (!isRazorpayConfigured()) return false;
  const expected = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/// Razorpay's server-to-server webhook: HMAC-SHA256 of the RAW body with the webhook
/// secret set in the Razorpay dashboard (a different secret from the API key's). Without a
/// secret configured, every webhook is refused.
export function verifyRazorpayWebhook(rawBody: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/// Refund a captured payment, in full or in part. Used only when a manager decides to
/// refund a patient's credit (§3, decision 3.c) — never automatically.
export async function refundRazorpayPayment(
  paymentId: string,
  amountPaise: number,
  notes: Record<string, string>,
): Promise<{ ok: true; refundId: string } | { ok: false; error: string }> {
  if (!isRazorpayConfigured()) return { ok: false, error: "Razorpay isn't configured" };
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ amount: amountPaise, notes }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
    if (!res.ok || !body.id) return { ok: false, error: body.error?.description ?? `Razorpay ${res.status}` };
    return { ok: true, refundId: body.id };
  } catch (err) {
    logger.error(`Razorpay refund failed for ${paymentId}: ${String(err)}`);
    return { ok: false, error: "Payment service unreachable" };
  }
}
