"use server";

// Server Actions for quotes (Phase 2 §multi-quote). Like the lead actions, every
// function re-checks the caller's capability (Server Functions are reachable via
// direct POST) and re-checks lead ownership so a scoped user can't act on a lead
// they can't see.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability, userCanAccessLead, type SessionUser } from "@/lib/authz";
import {
  createQuote,
  reviseQuotePrice,
  transitionQuote,
  setQuoteOwner,
  unlockQuote,
  QuoteError,
} from "@/lib/quotes";
import { buildQuotePdf, quoteRef } from "@/lib/quotePdf";
import { branchIdForUser, getBranchQuoteInfo } from "@/lib/branches";
import { sendLeadDocument } from "@/lib/messages";
import { writeAudit } from "@/lib/audit";
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
  // Grant-aware: also allows a colleague covering the lead via an active access grant.
  if (await userCanAccessLead(user, leadId)) return { ok: true };
  return { ok: false, error: "Not found" };
}

/// Raise a new quote on a lead. Enforces one-open-quote-per-treatment + cycle
/// numbering in the domain layer.
export async function createLeadQuote(input: {
  leadId: string;
  treatment: string;
  price?: string | number | null;
  discountType?: string | null;
  discountValue?: string | number | null;
  gstRate?: string | number | null;
  source?: string | null;
}): Promise<Result> {
  const user = await requireCapability("quotes.manage");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const treatment = (input.treatment ?? "").trim().slice(0, TREATMENT_MAX);
  if (!treatment) return { ok: false, error: "Treatment is required" };

  const price = parsePrice(input.price);
  if (price === "invalid") return { ok: false, error: "Price must be a whole number of rupees" };

  // GST rate comes from the chosen catalog item (5% or 0% for "NA" items). Clamp to a
  // sane range; fall back to the default when unset so manual quotes are unaffected.
  let gstRate: number | null = null;
  if (input.gstRate != null && input.gstRate !== "") {
    const g = typeof input.gstRate === "number" ? input.gstRate : Number(input.gstRate);
    if (!Number.isFinite(g) || g < 0 || g > 100) return { ok: false, error: "GST rate must be between 0 and 100" };
    gstRate = g;
  }

  // Discount: type "percent" | "inr", value a non-negative number (percent may be
  // decimal, e.g. 12.5). Percent is capped at 100.
  const discountType =
    input.discountType === "percent" || input.discountType === "inr" ? input.discountType : null;
  let discountValue: number | null = null;
  if (discountType && input.discountValue != null && input.discountValue !== "") {
    const n = typeof input.discountValue === "number" ? input.discountValue : Number(input.discountValue);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Discount must be a non-negative number" };
    if (discountType === "percent" && n > 100) return { ok: false, error: "Percentage discount can't exceed 100%" };
    discountValue = n;
  }

  // The quote belongs to the creating user's home branch (→ default branch). Drives
  // which legal entity / GSTIN / bank / address the PDF renders (§branches).
  const branchId = await branchIdForUser(user.id);

  let quoteId = "";
  try {
    quoteId = await createQuote({
      leadId: input.leadId,
      treatment,
      price,
      discountType: discountValue != null ? discountType : null,
      discountValue,
      gstRate,
      source: input.source ?? null,
      // Default this quote's owner to the lead's owner (may be re-assigned later).
      ownerRepId: user.salesRepId ?? null,
      branchId,
      createdById: user.id,
    });
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`createLeadQuote failed for ${input.leadId}: ${String(err)}`);
    return { ok: false, error: "Could not create the quote" };
  }
  // Recorded against the LEAD (entityType/id) so it shows in the lead's change
  // history; the quote is identified in meta.
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.quote.create",
    entityType: "lead",
    entityId: input.leadId,
    newValue: treatment,
    meta: { quoteId, treatment },
  });
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
/// Rejection needs a reason from the list; withdrawal needs a free-text reason.
export async function setLeadQuoteStatus(input: {
  quoteId: string;
  leadId: string;
  status: string;
  rejectionReason?: string | null;
  withdrawnReason?: string | null;
}): Promise<Result> {
  const cap = input.status === "converted" ? "quotes.convert" : "quotes.manage";
  const user = await requireCapability(cap);
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const before = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    select: { status: true },
  });

  try {
    await transitionQuote({
      quoteId: input.quoteId,
      status: input.status,
      rejectionReason: input.rejectionReason ?? null,
      withdrawnReason: input.withdrawnReason?.trim().slice(0, NOTE_MAX) ?? null,
      actorId: user.id,
    });
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`setLeadQuoteStatus failed for ${input.quoteId}: ${String(err)}`);
    return { ok: false, error: "Could not update the quote" };
  }
  // Record the effective status (acceptance advances straight to awaiting_payment,
  // mirroring transitionQuote). Any rejection/withdrawal reason rides along.
  const effectiveStatus = input.status === "accepted" ? "awaiting_payment" : input.status;
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.quote.status",
    entityType: "lead",
    entityId: input.leadId,
    oldValue: before?.status ?? null,
    newValue: effectiveStatus,
    reason: input.rejectionReason?.trim() || input.withdrawnReason?.trim() || null,
    meta: { quoteId: input.quoteId },
  });
  logger.info(`Quote ${input.quoteId} → ${input.status} by ${user.email ?? "?"}`);
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Generate the quote PDF and send it to the lead over WhatsApp (§multi-quote:
/// "the counsellor sends it from inside the lead record"). Only works inside the
/// 24h window; marks the quote as "sent" on success.
export async function sendLeadQuoteWhatsApp(input: {
  quoteId: string;
  leadId: string;
}): Promise<Result> {
  const user = await requireCapability("quotes.manage");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const quote = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    include: { lead: { select: { name: true, phone: true } } },
  });
  if (!quote || quote.leadId !== input.leadId) return { ok: false, error: "Quote not found" };

  let pdf: Buffer;
  try {
    pdf = await buildQuotePdf({
      quoteId: quote.id,
      treatment: quote.treatment,
      cycle: quote.cycle,
      price: quote.price,
      gstRate: quote.gstRate,
      discountType: quote.discountType,
      discountValue: quote.discountValue,
      totalPayable: quote.totalPayable,
      createdAt: quote.createdAt,
      expiresAt: quote.expiresAt,
      leadName: quote.lead.name,
      leadPhone: quote.lead.phone,
      branch: await getBranchQuoteInfo(quote.branchId),
    });
  } catch (err) {
    logger.error(`Quote PDF build failed for ${input.quoteId}: ${String(err)}`);
    return { ok: false, error: "Could not generate the quote PDF" };
  }

  const caption = `Your ${quote.treatment} quotation from our clinic. Total: Rs. ${(quote.totalPayable ?? 0).toLocaleString("en-IN")}.`;
  // When the 24h window is closed, fall back to the approved document template
  // (if one is configured in the environment) so the quote can go out proactively.
  const tmplName = process.env.QUOTE_DOC_TEMPLATE_NAME;
  const fallbackTemplate = tmplName
    ? {
        name: tmplName,
        lang: process.env.QUOTE_DOC_TEMPLATE_LANG ?? "en",
        bodyParams: [quote.lead.name], // fills the template's {{1}} (patient name)
      }
    : undefined;

  const res = await sendLeadDocument(
    input.leadId,
    { buffer: pdf, filename: `${quoteRef(quote.id, quote.cycle)}.pdf`, mime: "application/pdf" },
    caption,
    { sentBy: user.email ?? undefined, fallbackTemplate },
  );
  if (!res.ok) return { ok: false, error: res.error };

  // Advance drafted → sent (don't regress a further-along quote).
  if (quote.status === "drafted") {
    try {
      await transitionQuote({ quoteId: quote.id, status: "sent" });
      await writeAudit({
        actorId: user.id,
        actorEmail: user.email,
        action: "lead.quote.status",
        entityType: "lead",
        entityId: input.leadId,
        oldValue: "drafted",
        newValue: "sent",
        meta: { quoteId: quote.id, via: "whatsapp-send" },
      });
    } catch (err) {
      logger.error(`Quote ${quote.id} sent on WhatsApp but status update failed: ${String(err)}`);
    }
  }
  logger.info(`Quote ${quote.id} PDF sent on WhatsApp to lead ${input.leadId} by ${user.email ?? "?"}`);
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true };
}

/// Reassign a quote to a different counsellor (§multi-quote: a quote's owner may
/// differ from the lead's owner).
export async function setLeadQuoteOwner(input: {
  quoteId: string;
  leadId: string;
  ownerRepId: string | null;
}): Promise<Result> {
  const user = await requireCapability("quotes.manage");
  const seen = await assertCanSeeLead(user, input.leadId);
  if (!seen.ok) return seen;

  const before = await prisma.quote.findUnique({
    where: { id: input.quoteId },
    select: { ownerRepId: true },
  });

  try {
    await setQuoteOwner(input.quoteId, input.ownerRepId || null);
  } catch (err) {
    if (err instanceof QuoteError) return { ok: false, error: err.message };
    logger.error(`setLeadQuoteOwner failed for ${input.quoteId}: ${String(err)}`);
    return { ok: false, error: "Could not reassign the quote" };
  }
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "lead.quote.owner",
    entityType: "lead",
    entityId: input.leadId,
    oldValue: before?.ownerRepId ?? null,
    newValue: input.ownerRepId || null,
    meta: { quoteId: input.quoteId },
  });
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
