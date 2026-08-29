// Billing → CRM: an invoice was raised (§billing).
//
// This is the endpoint that makes "converted" mean something. The billing system
// posts the invoice it just raised, naming the QUOTE it was for and the BRANCH that
// raised it; the CRM records it, converts that quote, credits that branch, and opens
// the post-sales journey. Nobody in the CRM types an invoice branch.
//
// Authenticated with the shared secret (`x-webhook-secret`), like the other machine
// callbacks. Idempotent on the invoice number, because billing systems retry.
//
// The CRM stores no card or bank details — this payload carries a number, an amount,
// a branch and a date, and anything else sent is ignored.
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyWebhookSecret } from "@/lib/verify";
import { recordInvoice, InvoiceError } from "@/lib/invoices";
import { logger } from "@/lib/logger";

const schema = z
  .object({
    /// The invoice number as printed for the patient.
    invoiceNumber: z.string().min(1),
    /// The quote this invoice is for. Quote-level, never lead-level: two treatments
    /// can be invoiced by two branches and both must keep their own credit.
    quoteId: z.string().min(1),
    /// The invoicing branch — its CRM id, or its name as billing knows it.
    branchId: z.string().min(1).optional(),
    branchName: z.string().min(1).optional(),
    /// Whole rupees.
    amount: z.number().int().nonnegative(),
    currency: z.string().min(1).optional(),
    /// ISO timestamp of when billing raised it.
    issuedAt: z.string().datetime().optional(),
    externalId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  })
  .refine((v) => !!(v.branchId || v.branchName), {
    message: "Either branchId or branchName is required — the invoice must say who raised it",
  });

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) {
    logger.warn("Invoice webhook: bad or missing shared secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    logger.warn(`Invoice webhook rejected: ${detail}`);
    return NextResponse.json({ error: detail }, { status: 400 });
  }
  const d = parsed.data;

  try {
    const result = await recordInvoice({
      number: d.invoiceNumber,
      quoteId: d.quoteId,
      branchId: d.branchId ?? null,
      branchName: d.branchName ?? null,
      amount: d.amount,
      currency: d.currency,
      issuedAt: d.issuedAt ? new Date(d.issuedAt) : new Date(),
      externalId: d.externalId ?? null,
      source: d.source ?? "billing",
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof InvoiceError) {
      // A bad reference (unknown quote/branch) is the sender's to fix, so it gets a
      // 4xx and a sentence rather than a retry loop against a 500.
      logger.warn(`Invoice webhook could not be applied: ${err.message}`);
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    logger.error(`Invoice webhook failed: ${String(err)}`);
    return NextResponse.json({ error: "Could not record the invoice" }, { status: 500 });
  }
}
