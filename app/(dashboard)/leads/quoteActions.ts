"use server";

// Server Actions for quotes (Phase 2 §multi-quote). Like the lead actions, every
// function re-checks the caller's capability (Server Functions are reachable via
// direct POST) and re-checks lead ownership so a scoped user can't act on a lead
// they can't see.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability, canSeeLead, type SessionUser } from "@/lib/authz";
import {
  createQuote,
  reviseQuotePrice,
  transitionQuote,
  unlockQuote,
  QuoteError,
} from "@/lib/quotes";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string };

const TREATMENT_MAX = 120;
const NOTE_MAX = 300;

/// Guard: the caller must be allowed to see the lead this quote hangs off, so a
/// front-desk/telecaller can't reach another owner's lead by id.
async function assertCanSeeLead(
  user: SessionUser,
  leadId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedRepId: true, createdById: true },
  });
  if (!lead) return { ok: false, error: "Lead not found" };
  if (!canSeeLead(user, lead)) return { ok: false, error: "Not found" };
  return { ok: true };
}

/// Raise a new quote on a lead. Enforces one-open-quote-per-treatment + cycle
/// numbering in the domain layer.
export async function createLeadQuote(input: {
  leadId: string;
  treatment: string;
  price?: string | number | null;
  source?: string | null;
}): Promise<Result> {
  const user = await requireCapability("quotes.manage");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const treatment = (input.treatment ?? "").trim().slice(0, TREATMENT_MAX);
  if (!treatment) return { ok: false, error: "Treatment is required" };

  const price = parsePrice(input.price);
  if (price === "invalid") return { ok: false, error: "Price must be a whole number of rupees" };

  try {
    await createQuote({
      leadId: input.leadId,
      treatment,
      price,
      source: input.source ?? null,
      // Default this quote's owner to the lead's owner (may be re-assigned later).
      ownerRepId: user.salesRepId ?? null,
      createdById: user.id,
    });
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`createLeadQuote failed for ${input.leadId}: ${String(err)}`);
    return { ok: false, error: "Could not create the quote" };
  }
  logger.info(`Quote created on lead ${input.leadId} by ${user.email ?? "?"}`);
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Revise a quote's price (new version; old kept + marked replaced).
export async function reviseLeadQuotePrice(input: {
  quoteId: string;
  leadId: string;
  price: string | number;
  note?: string | null;
}): Promise<Result> {
  const user = await requireCapability("quotes.manage");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const price = parsePrice(input.price);
  if (price === "invalid" || price == null)
    return { ok: false, error: "Price must be a whole number of rupees" };

  try {
    await reviseQuotePrice({
      quoteId: input.quoteId,
      price,
      note: input.note?.trim().slice(0, NOTE_MAX) || null,
      createdById: user.id,
    });
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`reviseLeadQuotePrice failed for ${input.quoteId}: ${String(err)}`);
    return { ok: false, error: "Could not revise the quote" };
  }
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Move a quote through its lifecycle. `converted` needs the `quotes.convert`
/// capability (it's the money step); everything else needs `quotes.manage`.
export async function setLeadQuoteStatus(input: {
  quoteId: string;
  leadId: string;
  status: string;
  rejectionReason?: string | null;
}): Promise<Result> {
  const cap = input.status === "converted" ? "quotes.convert" : "quotes.manage";
  const user = await requireCapability(cap);
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  try {
    await transitionQuote({
      quoteId: input.quoteId,
      status: input.status,
      rejectionReason: input.rejectionReason ?? null,
    });
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`setLeadQuoteStatus failed for ${input.quoteId}: ${String(err)}`);
    return { ok: false, error: "Could not update the quote" };
  }
  logger.info(`Quote ${input.quoteId} → ${input.status} by ${user.email ?? "?"}`);
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Reopen a converted (locked) quote — Admin only (via the quotes.unlock wildcard).
export async function unlockLeadQuote(input: {
  quoteId: string;
  leadId: string;
  reason: string;
}): Promise<Result> {
  const user = await requireCapability("quotes.unlock");
  if (!input.reason?.trim()) return { ok: false, error: "A reason is required to unlock" };

  try {
    await unlockQuote(input.quoteId);
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`unlockLeadQuote failed for ${input.quoteId}: ${String(err)}`);
    return { ok: false, error: "Could not unlock the quote" };
  }
  logger.info(`Quote ${input.quoteId} unlocked by ${user.email ?? "?"}: ${input.reason.trim()}`);
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Parse a rupee price: whole non-negative integer, or null for blank. "invalid"
/// signals a parse error the caller turns into a user-facing message.
function parsePrice(v: string | number | null | undefined): number | null | "invalid" {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v.replace(/[,\s₹]/g, ""));
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return "invalid";
  return n;
}
