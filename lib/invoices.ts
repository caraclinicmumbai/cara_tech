// Invoices, and what they mean (§billing).
//
// The rule this module exists to enforce: **"converted" means an invoice exists for
// that specific quote**. Not a counsellor's optimism, not a status someone picked from
// a dropdown — a document the billing system raised. Recording the invoice is what
// converts the quote, and the branch that raised it earns the credit for it.
//
// Attached to the QUOTE, never the lead: a patient can have a transplant invoiced at
// one branch and a PRP course at another, and both branches earned their credit.
//
// The CRM stores no card or bank details. An invoice here is a number, an amount, a
// branch and a date — enough to attribute revenue, nothing that could be spent.
import { prisma } from "@/lib/prisma";
import { transitionQuote } from "@/lib/quotes";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export class InvoiceError extends Error {}

export type RecordInvoiceInput = {
  /// The billing system's invoice number, as printed for the patient.
  number: string;
  /// The quote this invoice paid for.
  quoteId: string;
  /// The INVOICING branch — by id, or by name/code as billing knows it.
  branchId?: string | null;
  branchName?: string | null;
  amount: number;
  currency?: string;
  issuedAt: Date;
  /// Which system sent it ("zenoti", "manual_admin", …).
  source?: string;
  externalId?: string | null;
  /// Set only when an Admin is recording an invoice by hand, with their reason.
  overrideReason?: string | null;
  /// For the audit trail when a human is involved.
  actorId?: string | null;
  actorEmail?: string | null;
};

export type RecordInvoiceResult = {
  invoiceId: string;
  quoteId: string;
  /// False when this exact invoice had already been recorded (a retried webhook).
  created: boolean;
  /// True when recording it moved the quote to converted.
  converted: boolean;
};

/// Resolve the invoicing branch from whatever billing sent. Matching by name is
/// deliberately exact-but-case-insensitive: a near-match would silently credit the
/// wrong branch, which is the one mistake this whole flow exists to prevent.
async function resolveBranch(input: RecordInvoiceInput): Promise<string> {
  if (input.branchId) {
    const byId = await prisma.branch.findUnique({ where: { id: input.branchId }, select: { id: true } });
    if (!byId) throw new InvoiceError(`Unknown branch id "${input.branchId}"`);
    return byId.id;
  }
  const name = input.branchName?.trim();
  if (!name) throw new InvoiceError("The invoice must say which branch raised it");
  const byName = await prisma.branch.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
  if (!byName) throw new InvoiceError(`No branch named "${name}" — add it under Branches first`);
  return byName.id;
}

/// Record an invoice against a quote and convert the quote. Idempotent on the invoice
/// number (billing systems retry), so a repeat delivery returns the existing row and
/// changes nothing.
export async function recordInvoice(input: RecordInvoiceInput): Promise<RecordInvoiceResult> {
  const number = input.number?.trim();
  if (!number) throw new InvoiceError("An invoice number is required");
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new InvoiceError("The invoice amount must be a positive whole number of rupees");
  }

  const quote = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    select: { id: true, status: true, leadId: true, treatment: true },
  });
  if (!quote) throw new InvoiceError(`No quote with id "${input.quoteId}"`);

  const existing = await prisma.invoice.findUnique({ where: { number }, select: { id: true, quoteId: true } });
  if (existing) {
    if (existing.quoteId !== quote.id) {
      throw new InvoiceError(`Invoice ${number} is already recorded against a different quote`);
    }
    return { invoiceId: existing.id, quoteId: quote.id, created: false, converted: false };
  }

  const branchId = await resolveBranch(input);

  const invoice = await prisma.invoice.create({
    data: {
      number,
      externalId: input.externalId?.trim() || null,
      quoteId: quote.id,
      branchId,
      amount: Math.round(input.amount),
      currency: input.currency?.trim() || "INR",
      issuedAt: input.issuedAt,
      source: input.source?.trim() || "billing",
      overrideReason: input.overrideReason?.trim() || null,
    },
  });

  // The invoice IS the conversion. transitionQuote stamps convertedAt, locks the
  // quote and opens the post-sales journey; the invoicing branch is passed through
  // so the credit is set from billing rather than typed by anyone.
  let converted = false;
  if (quote.status !== "converted") {
    await transitionQuote({
      quoteId: quote.id,
      status: "converted",
      invoicedBranchId: branchId,
      actorId: input.actorId ?? null,
      invoiceBacked: true, // the invoice we just recorded IS the backing
    });
    converted = true;
  } else {
    // Already converted (e.g. an admin override earlier) — still record where the
    // credit belongs, because that's what this invoice proves.
    await prisma.quote.update({ where: { id: quote.id }, data: { invoicedBranchId: branchId } });
  }

  await writeAudit({
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: "lead.quote.invoiced",
    entityType: "lead",
    entityId: quote.leadId,
    newValue: number,
    reason: input.overrideReason ?? null,
    meta: {
      quoteId: quote.id,
      invoiceId: invoice.id,
      branchId,
      amount: invoice.amount,
      source: invoice.source,
      converted,
    },
  });

  logger.info(
    `Invoice ${number} recorded for quote ${quote.id} (${quote.treatment}) — branch ${branchId}` +
      (converted ? " → converted" : " (already converted)"),
  );
  return { invoiceId: invoice.id, quoteId: quote.id, created: true, converted };
}

/// Does this quote have an invoice? The question `transitionQuote` asks before it
/// will let anyone mark a quote converted by hand.
export async function quoteHasInvoice(quoteId: string): Promise<boolean> {
  const n = await prisma.invoice.count({ where: { quoteId } });
  return n > 0;
}

export type InvoiceView = {
  id: string;
  number: string;
  amount: number;
  currency: string;
  branchName: string;
  issuedAt: string; // ISO
  source: string;
  overrideReason: string | null;
};

/// Invoices on a quote, newest first — for the quote row on the lead page.
export async function listInvoicesForQuotes(quoteIds: string[]): Promise<Map<string, InvoiceView[]>> {
  if (quoteIds.length === 0) return new Map();
  const rows = await prisma.invoice.findMany({
    where: { quoteId: { in: quoteIds } },
    orderBy: { issuedAt: "desc" },
    select: {
      id: true,
      quoteId: true,
      number: true,
      amount: true,
      currency: true,
      issuedAt: true,
      source: true,
      overrideReason: true,
      branch: { select: { name: true } },
    },
  });
  const map = new Map<string, InvoiceView[]>();
  for (const r of rows) {
    const list = map.get(r.quoteId) ?? [];
    list.push({
      id: r.id,
      number: r.number,
      amount: r.amount,
      currency: r.currency,
      branchName: r.branch.name,
      issuedAt: r.issuedAt.toISOString(),
      source: r.source,
      overrideReason: r.overrideReason,
    });
    map.set(r.quoteId, list);
  }
  return map;
}
