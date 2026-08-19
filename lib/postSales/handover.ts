// The handover summary (§post-sales "Handing Over Cleanly"). Generated per CONVERTED
// QUOTE — not per lead — and it is the ONLY view of the patient the post-sales team
// gets: "The post-sales team sees the summary — not the full call recordings."
//
// That last line is a hard constraint, not a preference. Nothing in this module reads
// Call.transcript, Call.recordingUrl, or the CQS breakdown, and the post-sales roles
// are not granted `calls.view` (lib/rbac.ts), so there is no route to a recording from
// the ERP at all.
//
// The summary is snapshotted onto the journey at conversion (a permanent record of what
// was handed over) AND recomputed for display, because two parts of it are volatile and
// must be current for a clinician: the patient's safety flags, and which OTHER quotes
// are open on this person.
// NOTE: this module deliberately imports only from lib/quoteStages (pure constants),
// never from lib/quotes — the conversion path in lib/quotes calls into the journey
// layer, which calls in here, so a dependency the other way would close a cycle.
import { prisma } from "@/lib/prisma";
import { computeQuoteTotals, isQuoteOpen } from "@/lib/quoteStages";
import { logger } from "@/lib/logger";

/// A safety flag a clinician must see before touching the patient. Mirrors the Lead
/// protection flags (§compliance) plus the hard messaging suppression.
export type SafetyFlag = { key: string; label: string; note: string | null };

export type OtherQuote = {
  id: string;
  treatment: string;
  status: string;
  cycle: number;
  open: boolean;
  totalPayable: number | null;
};

export type HandoverSummary = {
  generatedAt: string; // ISO

  // Who + what.
  patientName: string;
  patientPhone: string;
  leadId: string;
  quoteId: string;
  procedure: string; // the SPECIFIC treatment this journey is for
  cycle: number; // 1 = first time, 2 = repeat session, …

  // Money (no card or bank details — ever, §"The CRM never stores card numbers").
  price: number | null; // base
  totalPayable: number | null; // base − discount + GST
  currency: string;
  discountLabel: string | null;

  // Which branch earned the credit. `invoicedBranch` is what billing told us;
  // `raisedBranch` is where the quote was written, shown when they differ.
  invoicedBranchName: string | null;
  invoicedBranchCode: string | null;
  raisedBranchName: string | null;

  // How to talk to them.
  language: string | null;
  commsPreferences: string[]; // plain sentences, e.g. "Opted out of promotional messages"
  clinicalConsent: "given" | "assumed" | "withheld";

  // Care context.
  safetyFlags: SafetyFlag[];
  notes: { author: string; at: string; body: string }[]; // counsellor notes, NOT transcripts
  attribution: string | null; // what brought THIS quote about

  // Everything else running on this person.
  otherQuotes: OtherQuote[];
  otherQuotesLabel: string; // e.g. "1 other quote open — PRP (Sent)"

  soldBy: string | null; // counsellor who owned the quote
  convertedAt: string | null; // ISO
};

/// How many counsellor notes ride along on the handover. Enough for context, not so
/// many that a clinician scrolls past the important one.
const NOTE_LIMIT = 10;

function discountLabel(q: {
  price: number | null;
  gstRate: number;
  discountType: string | null;
  discountValue: number | null;
}): string | null {
  if (!q.discountType || !q.discountValue) return null;
  const totals = computeQuoteTotals({
    base: q.price,
    gstRate: q.gstRate,
    discountType: q.discountType,
    discountValue: q.discountValue,
  });
  const shown = q.discountType === "percent" ? `${q.discountValue}%` : `₹${q.discountValue.toLocaleString("en-IN")}`;
  return `${shown} (−₹${totals.discountAmount.toLocaleString("en-IN")})`;
}

/// The patient's protection/safety flags, as sentences a clinician can act on.
function safetyFlags(lead: {
  possibleMinor: boolean;
  hearingImpaired: boolean;
  legalThreatFreeze: boolean;
  complaintOpen: boolean;
  onDnd: boolean;
  protectionNote: string | null;
}): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  const note = lead.protectionNote?.trim() || null;
  if (lead.possibleMinor)
    flags.push({ key: "possible_minor", label: "Possibly a minor — guardian consent required", note });
  if (lead.hearingImpaired)
    flags.push({ key: "hearing_impaired", label: "Hearing impaired — do not phone, use WhatsApp", note });
  if (lead.legalThreatFreeze)
    flags.push({ key: "legal_threat", label: "Legal-threat freeze — no automated contact", note });
  if (lead.complaintOpen)
    flags.push({ key: "complaint_open", label: "Open complaint — handle personally", note });
  if (lead.onDnd) flags.push({ key: "dnd", label: "On the Do-Not-Call registry", note: null });
  return flags;
}

/// Communication preferences as plain sentences. Deliberately spells out the
/// distinction that matters most in post-sales: a marketing opt-out does NOT stop
/// clinical care messages.
function commsPreferences(lead: {
  optedOut: boolean;
  consentCall: boolean | null;
  consentMarketing: boolean | null;
  consentClinical: boolean | null;
  hearingImpaired: boolean;
}): string[] {
  const out: string[] = [];
  if (lead.optedOut) out.push("Opted out of sales/marketing messages — care messages still apply");
  if (lead.consentCall === false) out.push("Does not consent to phone calls");
  else if (lead.consentCall === true) out.push("Happy to be called");
  if (lead.consentMarketing === false) out.push("No promotional messages");
  if (lead.consentClinical === false) out.push("⚠️ Clinical consent WITHHELD — no automated care messages");
  if (lead.hearingImpaired) out.push("Hearing impaired — prefer written contact");
  if (out.length === 0) out.push("No specific preferences recorded");
  return out;
}

/// Clinical consent state for care messages. `assumed` is the normal case for a
/// converted patient: nothing explicit was recorded, and a patient under the clinic's
/// care is treated as consenting to care messages. Only an explicit false withholds.
function clinicalConsent(consentClinical: boolean | null): "given" | "assumed" | "withheld" {
  if (consentClinical === true) return "given";
  if (consentClinical === false) return "withheld";
  return "assumed";
}

const SOURCE_LABELS: Record<string, string> = {
  ad: "Ad / original enquiry",
  asked_during_consultation: "Asked during consultation",
  post_op_upsell: "Post-op upsell",
  existing_patient_repeat: "Existing patient — repeat",
};

/// Build the handover summary for a converted quote. Returns null if the quote is
/// gone. Reads no recordings, no transcripts, no CQS.
export async function buildHandoverSummary(quoteId: string): Promise<HandoverSummary | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      leadId: true,
      treatment: true,
      cycle: true,
      price: true,
      totalPayable: true,
      currency: true,
      gstRate: true,
      discountType: true,
      discountValue: true,
      source: true,
      convertedAt: true,
      ownerRep: { select: { name: true } },
      branch: { select: { name: true } },
      invoicedBranch: { select: { name: true, code: true } },
      lead: {
        select: {
          id: true,
          name: true,
          phone: true,
          preferredLanguage: true,
          optedOut: true,
          consentCall: true,
          consentMarketing: true,
          consentClinical: true,
          possibleMinor: true,
          hearingImpaired: true,
          legalThreatFreeze: true,
          complaintOpen: true,
          onDnd: true,
          protectionNote: true,
          // Counsellor notes — the human context sales captured. NOT call recordings.
          comments: {
            orderBy: { createdAt: "desc" },
            take: NOTE_LIMIT,
            select: { authorName: true, createdAt: true, body: true },
          },
          // Every other quote on this person, so post-sales knows what else is live
          // (§"a note of any other quotes open on this person").
          quotes: {
            where: { id: { not: quoteId } },
            orderBy: { createdAt: "desc" },
            select: { id: true, treatment: true, status: true, cycle: true, totalPayable: true },
          },
        },
      },
    },
  });
  if (!quote) return null;

  const lead = quote.lead;
  const otherQuotes: OtherQuote[] = lead.quotes.map((q) => ({
    id: q.id,
    treatment: q.treatment,
    status: q.status,
    cycle: q.cycle,
    open: isQuoteOpen(q.status),
    totalPayable: q.totalPayable,
  }));
  const openOthers = otherQuotes.filter((q) => q.open);

  return {
    generatedAt: new Date().toISOString(),
    patientName: lead.name,
    patientPhone: lead.phone,
    leadId: lead.id,
    quoteId: quote.id,
    procedure: quote.treatment,
    cycle: quote.cycle,
    price: quote.price,
    totalPayable: quote.totalPayable,
    currency: quote.currency,
    discountLabel: discountLabel(quote),
    invoicedBranchName: quote.invoicedBranch?.name ?? null,
    invoicedBranchCode: quote.invoicedBranch?.code ?? null,
    raisedBranchName: quote.branch?.name ?? null,
    language: lead.preferredLanguage,
    commsPreferences: commsPreferences(lead),
    clinicalConsent: clinicalConsent(lead.consentClinical),
    safetyFlags: safetyFlags(lead),
    notes: lead.comments.map((c) => ({
      author: c.authorName ?? "Staff",
      at: c.createdAt.toISOString(),
      body: c.body,
    })),
    attribution: quote.source ? (SOURCE_LABELS[quote.source] ?? quote.source) : null,
    otherQuotes,
    // §"a note of any other quotes open on this person" — the line that stops the
    // clinical team assuming this is the patient's only treatment.
    otherQuotesLabel: openOthers.length
      ? `${openOthers.length} other quote${openOthers.length === 1 ? "" : "s"} open — ${openOthers
          .map((q) => q.treatment)
          .join(", ")}`
      : otherQuotes.length
        ? `${otherQuotes.length} other quote${otherQuotes.length === 1 ? "" : "s"} on this patient, none open`
        : "No other quotes on this patient",
    soldBy: quote.ownerRep?.name ?? null,
    convertedAt: quote.convertedAt?.toISOString() ?? null,
  };
}

/// Snapshot the summary onto the journey. Best-effort: a failure here must never
/// block a conversion, because the journey page recomputes the summary live anyway.
export async function snapshotHandoverSummary(journeyId: string, quoteId: string): Promise<void> {
  try {
    const summary = await buildHandoverSummary(quoteId);
    if (!summary) return;
    await prisma.postSalesJourney.update({
      where: { id: journeyId },
      data: {
        handoverSummary: summary as unknown as object,
        handoverGeneratedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error(`Handover summary snapshot failed for journey ${journeyId}: ${String(err)}`);
  }
}
