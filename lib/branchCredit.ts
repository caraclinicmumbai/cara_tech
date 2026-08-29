// Branch credit and the 7-day dispute (§branch credit).
//
// The rule the clinic agreed: **the branch that raised the invoice gets the credit for
// that quote.** No exceptions, no negotiation, no field to type it into — the CRM reads
// it off the invoice (lib/invoices.ts) so the argument can't start.
//
// The one release valve is here. A branch that believes the credit is theirs has seven
// days to say so in writing; the Sales Head decides once; the decision is final and
// logged. Upholding moves the credit — that is the ONLY path by which a credit ever
// moves, which is what makes "the system enforces it" true rather than aspirational.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { notifyRep } from "@/lib/notifications";
import { logger } from "@/lib/logger";

export class DisputeError extends Error {}

/// How long a branch has to dispute, from the moment the credit landed.
export const DISPUTE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/// When the credit landed on this quote: its conversion, else the earliest invoice.
/// Null when the quote isn't credited yet — nothing to dispute.
function creditLandedAt(quote: {
  convertedAt: Date | null;
  invoices: { issuedAt: Date; receivedAt: Date }[];
}): Date | null {
  if (quote.convertedAt) return quote.convertedAt;
  const first = quote.invoices.map((i) => i.receivedAt).sort((a, b) => a.getTime() - b.getTime())[0];
  return first ?? null;
}

export type DisputeView = {
  id: string;
  status: string;
  reason: string;
  claimantBranchName: string;
  creditedBranchName: string;
  raisedAt: string; // ISO
  windowEndsAt: string; // ISO
  decidedAt: string | null;
  decisionNote: string | null;
};

export type CreditView = {
  quoteId: string;
  /// The branch currently credited, and where that came from.
  creditedBranchId: string | null;
  creditedBranchName: string | null;
  /// Can a dispute still be raised — credited, undisputed, and inside the window.
  disputable: boolean;
  /// When the window closes (null when the quote isn't credited).
  windowEndsAt: string | null;
  dispute: DisputeView | null;
};

function toView(d: {
  id: string;
  status: string;
  reason: string;
  raisedAt: Date;
  windowEndsAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  claimantBranch: { name: string };
  creditedBranch: { name: string };
}): DisputeView {
  return {
    id: d.id,
    status: d.status,
    reason: d.reason,
    claimantBranchName: d.claimantBranch.name,
    creditedBranchName: d.creditedBranch.name,
    raisedAt: d.raisedAt.toISOString(),
    windowEndsAt: d.windowEndsAt.toISOString(),
    decidedAt: d.decidedAt?.toISOString() ?? null,
    decisionNote: d.decisionNote,
  };
}

/// Credit + dispute state for a set of quotes, for the lead page and the desk.
export async function getCreditState(
  quoteIds: string[],
  now: number = Date.now(),
): Promise<Map<string, CreditView>> {
  const map = new Map<string, CreditView>();
  if (quoteIds.length === 0) return map;

  const quotes = await prisma.quote.findMany({
    where: { id: { in: quoteIds } },
    select: {
      id: true,
      convertedAt: true,
      invoicedBranchId: true,
      invoicedBranch: { select: { name: true } },
      invoices: { select: { issuedAt: true, receivedAt: true } },
      creditDispute: {
        select: {
          id: true,
          status: true,
          reason: true,
          raisedAt: true,
          windowEndsAt: true,
          decidedAt: true,
          decisionNote: true,
          claimantBranch: { select: { name: true } },
          creditedBranch: { select: { name: true } },
        },
      },
    },
  });

  for (const q of quotes) {
    const landed = creditLandedAt(q);
    const windowEndsAt = landed ? new Date(landed.getTime() + DISPUTE_WINDOW_DAYS * DAY_MS) : null;
    map.set(q.id, {
      quoteId: q.id,
      creditedBranchId: q.invoicedBranchId,
      creditedBranchName: q.invoicedBranch?.name ?? null,
      disputable:
        !!q.invoicedBranchId && !q.creditDispute && !!windowEndsAt && windowEndsAt.getTime() > now,
      windowEndsAt: windowEndsAt?.toISOString() ?? null,
      dispute: q.creditDispute ? toView(q.creditDispute) : null,
    });
  }
  return map;
}

/// Raise the one dispute this quote may carry. Refused outside the 7-day window, on an
/// uncredited quote, when the claimant already holds the credit, or when a dispute has
/// already been decided — "final" has to mean something.
export async function raiseCreditDispute(input: {
  quoteId: string;
  claimantBranchId: string;
  reason: string;
  actorId?: string | null;
  actorEmail?: string | null;
  now?: Date;
}): Promise<{ disputeId: string }> {
  const reason = input.reason?.trim();
  if (!reason) throw new DisputeError("Say why the credit belongs to your branch — it's on the record.");

  const quote = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    select: {
      id: true,
      leadId: true,
      treatment: true,
      convertedAt: true,
      invoicedBranchId: true,
      invoices: { select: { issuedAt: true, receivedAt: true } },
      creditDispute: { select: { id: true, status: true } },
    },
  });
  if (!quote) throw new DisputeError("Quote not found");
  if (!quote.invoicedBranchId) {
    throw new DisputeError("This quote hasn't been credited to a branch yet — there's nothing to dispute.");
  }
  if (quote.invoicedBranchId === input.claimantBranchId) {
    throw new DisputeError("Your branch already holds the credit for this quote.");
  }
  if (quote.creditDispute) {
    throw new DisputeError(
      quote.creditDispute.status === "open"
        ? "A dispute is already open on this quote."
        : "This quote's credit was already decided — that decision is final.",
    );
  }

  const now = input.now ?? new Date();
  const landed = creditLandedAt(quote);
  const windowEndsAt = new Date((landed ?? now).getTime() + DISPUTE_WINDOW_DAYS * DAY_MS);
  if (now > windowEndsAt) {
    throw new DisputeError(
      `The ${DISPUTE_WINDOW_DAYS}-day window to dispute this credit closed on ${windowEndsAt.toDateString()}.`,
    );
  }

  const dispute = await prisma.quoteCreditDispute.create({
    data: {
      quoteId: quote.id,
      claimantBranchId: input.claimantBranchId,
      creditedBranchId: quote.invoicedBranchId,
      raisedById: input.actorId ?? null,
      reason,
      windowEndsAt,
    },
  });

  await writeAudit({
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: "lead.quote.credit.dispute",
    entityType: "lead",
    entityId: quote.leadId,
    oldValue: quote.invoicedBranchId,
    newValue: input.claimantBranchId,
    reason,
    meta: { quoteId: quote.id, disputeId: dispute.id, windowEndsAt: windowEndsAt.toISOString() },
  });

  // The Sales Head is the one who decides — tell them it's waiting.
  await notifySalesHead(
    `⚖️ Branch credit disputed — ${quote.treatment}`,
    `${reason} · decide it on the lead.`,
    quote.leadId,
  );

  logger.info(`Credit dispute raised on quote ${quote.id} by branch ${input.claimantBranchId}`);
  return { disputeId: dispute.id };
}

/// Decide a dispute. Once. `uphold` moves the credit to the claimant; either way the
/// reasoning is recorded and the dispute closes for good.
export async function decideCreditDispute(input: {
  disputeId: string;
  uphold: boolean;
  note: string;
  actorId?: string | null;
  actorEmail?: string | null;
}): Promise<void> {
  const note = input.note?.trim();
  if (!note) throw new DisputeError("A decision needs a reason — it's final and it's logged.");

  const dispute = await prisma.quoteCreditDispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      status: true,
      quoteId: true,
      claimantBranchId: true,
      creditedBranchId: true,
      quote: { select: { leadId: true, treatment: true } },
    },
  });
  if (!dispute) throw new DisputeError("Dispute not found");
  if (dispute.status !== "open") throw new DisputeError("This dispute was already decided — the decision is final.");

  await prisma.$transaction(async (tx) => {
    await tx.quoteCreditDispute.update({
      where: { id: dispute.id },
      data: {
        status: input.uphold ? "upheld" : "rejected",
        decidedById: input.actorId ?? null,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    // Upholding is the only way a credit ever moves.
    if (input.uphold) {
      await tx.quote.update({
        where: { id: dispute.quoteId },
        data: { invoicedBranchId: dispute.claimantBranchId },
      });
    }
  });

  await writeAudit({
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: "lead.quote.credit.decision",
    entityType: "lead",
    entityId: dispute.quote.leadId,
    oldValue: dispute.creditedBranchId,
    newValue: input.uphold ? dispute.claimantBranchId : dispute.creditedBranchId,
    reason: note,
    meta: { quoteId: dispute.quoteId, disputeId: dispute.id, upheld: input.uphold },
  });

  logger.info(
    `Credit dispute ${dispute.id} ${input.uphold ? "UPHELD — credit moved" : "rejected — credit stands"} on quote ${dispute.quoteId}`,
  );
}

/// Bell the Sales Head(s). Best-effort: a notification hiccup must not fail a decision.
async function notifySalesHead(title: string, body: string, leadId: string): Promise<void> {
  try {
    const heads = await prisma.salesRep.findMany({
      where: { active: true, salesHead: true },
      select: { id: true },
    });
    for (const h of heads) {
      await notifyRep(h.id, { kind: "handover", title, body, leadId });
    }
  } catch (err) {
    logger.error(`Could not notify the sales head about a credit dispute: ${String(err)}`);
  }
}
