// Quote domain logic (Phase 2 §multi-quote). The rules that keep multi-quote from
// turning into a mess live here, so every caller (server actions, call intake)
// enforces them the same way:
//   • One OPEN quote per treatment at a time — a second raises an error, revise instead.
//   • A new cycle only starts once the previous quote for that treatment is closed.
//   • Revising a price REPLACES the current version (kept, marked replaced), never
//     creates a new quote.
//   • On conversion the QUOTE locks (read-only). The LEAD never locks.
//   • No quote or version is ever deleted (withdraw instead).

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_QUOTE_STATUS,
  QUOTE_DEFAULT_VALIDITY_DAYS,
  QUOTE_REJECTION_REASONS,
  WON_QUOTE_STATUSES,
  isQuoteOpen,
  isQuoteLocked,
  isQuoteStatus,
} from "@/lib/quoteStages";

/// Normalise a treatment name for the "one open quote per treatment" comparison —
/// case/space-insensitive so "Hair Transplant" and "hair transplant " collide.
function treatmentKey(treatment: string): string {
  return treatment.trim().toLowerCase().replace(/\s+/g, " ");
}

export type LeadQuoteSummary = {
  total: number;
  converted: number;
  open: number;
  label: string; // e.g. "2 quotes — 1 converted, 1 open"
};

/// The one-line roll-up shown on the lead: the lead never "converts", it summarises
/// its quotes (§multi-quote).
export function summariseQuotes(
  quotes: { status: string }[],
): LeadQuoteSummary {
  const total = quotes.length;
  const converted = quotes.filter((q) =>
    (WON_QUOTE_STATUSES as string[]).includes(q.status),
  ).length;
  const open = quotes.filter((q) => isQuoteOpen(q.status)).length;

  if (total === 0) return { total, converted, open, label: "No quotes yet" };
  const parts: string[] = [];
  if (converted) parts.push(`${converted} converted`);
  if (open) parts.push(`${open} open`);
  const closedLost = total - converted - open;
  if (closedLost) parts.push(`${closedLost} closed`);
  const noun = total === 1 ? "quote" : "quotes";
  return { total, converted, open, label: `${total} ${noun}${parts.length ? " — " + parts.join(", ") : ""}` };
}

export class QuoteError extends Error {}

/// Create a new quote on a lead. Enforces the one-open-per-treatment rule and
/// auto-numbers the cycle (how many times we've quoted this person for this
/// treatment). Seeds an initial price version when a price is given.
export async function createQuote(input: {
  leadId: string;
  treatment: string;
  price?: number | null;
  source?: string | null;
  ownerRepId?: string | null;
  createdById?: string | null;
  validityDays?: number;
}): Promise<string> {
  const treatment = input.treatment.trim();
  if (!treatment) throw new QuoteError("Treatment is required");
  const key = treatmentKey(treatment);

  // Same-treatment quotes on this lead, to enforce the open-quote rule + cycle no.
  const siblings = await prisma.quote.findMany({
    where: { leadId: input.leadId },
    select: { id: true, treatment: true, status: true },
  });
  const sameTreatment = siblings.filter((q) => treatmentKey(q.treatment) === key);
  if (sameTreatment.some((q) => isQuoteOpen(q.status))) {
    throw new QuoteError(
      `An open quote for "${treatment}" already exists — revise it instead of raising a second.`,
    );
  }
  const cycle = sameTreatment.length + 1;

  const expiresAt = new Date(
    Date.now() + (input.validityDays ?? QUOTE_DEFAULT_VALIDITY_DAYS) * 24 * 60 * 60 * 1000,
  );

  const created = await prisma.quote.create({
    data: {
      leadId: input.leadId,
      treatment,
      status: DEFAULT_QUOTE_STATUS,
      cycle,
      price: input.price ?? null,
      source: input.source ?? null,
      ownerRepId: input.ownerRepId ?? null,
      createdById: input.createdById ?? null,
      expiresAt,
      versions:
        input.price != null
          ? { create: [{ price: input.price, createdById: input.createdById ?? null }] }
          : undefined,
    },
    select: { id: true },
  });
  return created.id;
}

/// Revise a quote's price. Marks the current version replaced and appends a new one
/// — the quote keeps its identity and full price trail (§multi-quote). Refuses on a
/// locked (converted) quote.
export async function reviseQuotePrice(input: {
  quoteId: string;
  price: number;
  note?: string | null;
  createdById?: string | null;
}): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    select: { status: true },
  });
  if (!quote) throw new QuoteError("Quote not found");
  if (isQuoteLocked(quote.status)) {
    throw new QuoteError("This quote is converted and locked — an Admin must unlock it first.");
  }

  await prisma.$transaction([
    prisma.quoteVersion.updateMany({
      where: { quoteId: input.quoteId, replaced: false },
      data: { replaced: true },
    }),
    prisma.quoteVersion.create({
      data: {
        quoteId: input.quoteId,
        price: input.price,
        note: input.note ?? null,
        createdById: input.createdById ?? null,
      },
    }),
    prisma.quote.update({ where: { id: input.quoteId }, data: { price: input.price } }),
  ]);
}

/// Move a quote to a new status. Enforces: locked quotes are read-only; rejection
/// needs a reason FROM THE LIST; withdrawal keeps a reason + the actor's name;
/// acceptance means "awaiting payment" (acceptance ≠ conversion); conversion stamps
/// convertedAt + locks the quote (never the lead).
export async function transitionQuote(input: {
  quoteId: string;
  status: string;
  rejectionReason?: string | null;
  withdrawnReason?: string | null;
  actorId?: string | null;
  invoicedBranchId?: string | null;
}): Promise<void> {
  if (!isQuoteStatus(input.status)) throw new QuoteError("Invalid quote status");

  const quote = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    select: { status: true },
  });
  if (!quote) throw new QuoteError("Quote not found");
  if (isQuoteLocked(quote.status) && input.status !== quote.status) {
    throw new QuoteError("This quote is converted and locked — an Admin must unlock it first.");
  }

  // §multi-quote: rejection reason is mandatory AND from the fixed list.
  if (input.status === "rejected") {
    const reason = input.rejectionReason?.trim();
    if (!reason) throw new QuoteError("A rejection reason is required.");
    if (!(QUOTE_REJECTION_REASONS as readonly string[]).includes(reason)) {
      throw new QuoteError("Rejection reason must be chosen from the list.");
    }
  }
  // §multi-quote: a withdrawn quote is never deleted — it keeps a reason + a name.
  if (input.status === "withdrawn" && !input.withdrawnReason?.trim()) {
    throw new QuoteError("A withdrawal reason is required.");
  }

  // Acceptance sets "Accepted — Awaiting Payment": conversion is a separate step
  // that needs money, so accepting advances straight to awaiting_payment.
  const nextStatus = input.status === "accepted" ? "awaiting_payment" : input.status;

  const data: Prisma.QuoteUpdateInput = { status: nextStatus };
  if (input.status === "rejected") {
    data.rejectionReason = input.rejectionReason!.trim();
    if (input.actorId) data.closedById = input.actorId;
  }
  if (input.status === "withdrawn") {
    data.withdrawnReason = input.withdrawnReason!.trim();
    if (input.actorId) data.closedById = input.actorId;
  }
  if (input.status === "converted") {
    data.convertedAt = new Date();
    data.lockedAt = new Date();
    if (input.invoicedBranchId) {
      data.invoicedBranch = { connect: { id: input.invoicedBranchId } };
    }
  }
  await prisma.quote.update({ where: { id: input.quoteId }, data });
}

/// Reassign a quote to a different counsellor (§multi-quote: a quote's owner may
/// differ from the lead's owner). Refuses on a locked quote.
export async function setQuoteOwner(quoteId: string, ownerRepId: string | null): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { status: true },
  });
  if (!quote) throw new QuoteError("Quote not found");
  if (isQuoteLocked(quote.status)) {
    throw new QuoteError("This quote is converted and locked — an Admin must unlock it first.");
  }
  await prisma.quote.update({ where: { id: quoteId }, data: { ownerRepId } });
}

/// Reopen a converted (locked) quote — Admin only, always with a written reason
/// (§multi-quote). Clears the lock so the quote can be edited again.
export async function unlockQuote(quoteId: string): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { status: true, lockedAt: true },
  });
  if (!quote) throw new QuoteError("Quote not found");
  if (!quote.lockedAt) throw new QuoteError("This quote isn't locked.");
  await prisma.quote.update({
    where: { id: quoteId },
    data: { lockedAt: null, status: "accepted" },
  });
}
