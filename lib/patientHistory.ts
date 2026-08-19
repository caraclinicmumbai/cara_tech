// The internal patient history record (§multi-quote → conversion). Everything the
// clinic knows about one converted patient, assembled for the downloadable summary
// PDF: who owned them, what was quoted, every conversation, and every single contact
// that ever happened — calls, WhatsApp both ways, staff notes, follow-up steps, care
// check-ins — merged into one chronological timeline.
//
// ⚠️ This is the OPPOSITE of lib/postSales/handover.ts by design. The handover summary
// deliberately withholds transcripts and recordings because the clinical team must not
// see them. This record deliberately includes them: it is an INTERNAL sales/management
// document, and the route that serves it is gated on `calls.view`, which none of the
// clinical roles hold. Do not wire this into the post-sales UI.
//
// Anchored to the CONVERTED QUOTE, not the lead, because that is the system's unit of
// conversion (§multi-quote): a patient who converts two treatments gets two records,
// each with its own quotation, sharing the person-level history.
import { prisma } from "@/lib/prisma";
import { computeQuoteTotals, QUOTE_STATUS_LABELS, QUOTE_SOURCE_LABELS, type QuoteStatus, type QuoteSource } from "@/lib/quoteStages";
import { stageLabel } from "@/lib/leadStages";

/// One thing that happened with the patient, whatever the channel.
export type ContactEvent = {
  at: Date;
  /// call | whatsapp_in | whatsapp_out | note | follow_up | check_in | quote
  kind: string;
  /// Channel label for the timeline column ("AI call", "WhatsApp in", …).
  channel: string;
  /// One-line description.
  summary: string;
  /// Who did it (rep/staff name or email), null for the patient or the system.
  actor: string | null;
  /// Extra facts rendered under the line (outcome, duration, CQS, status).
  detail: string | null;
};

/// A call, expanded — the conversation record proper.
export type CallRecord = {
  at: Date;
  type: string;
  outcome: string | null;
  sentiment: string | null;
  durationSec: number | null;
  cqs: number | null;
  cqsSummary: string | null;
  objection: string | null;
  handledBy: string | null;
  recordingConsent: boolean | null;
  transcript: string | null;
};

export type PatientHistory = {
  generatedAt: Date;

  // ── Who ──
  leadId: string;
  patientName: string;
  patientPhone: string;
  patientEmail: string | null;
  leadStageLabel: string;
  leadCreatedAt: Date;
  source: string | null;
  campaign: string | null;
  preferredLanguage: string | null;

  // ── Ownership ──
  /// The counsellor/telecaller who owned THIS quote at conversion.
  quoteOwner: string | null;
  /// The rep who owns the person (may differ from the quote owner).
  leadOwner: string | null;

  // ── The quotation ──
  quoteId: string;
  quoteRef: string;
  treatment: string;
  cycle: number;
  quoteStatusLabel: string;
  quoteSourceLabel: string | null;
  base: number;
  discountLabel: string | null;
  discountAmount: number;
  gstRate: number;
  gstAmount: number;
  total: number;
  quotedAt: Date;
  convertedAt: Date | null;
  raisedBranch: string | null;
  invoicedBranch: string | null;
  /// Price revisions, oldest first (the opening version included, labelled).
  priceTrail: { at: Date; price: number; note: string | null; opening: boolean }[];
  /// The patient's other quotes, so the record isn't read as their only treatment.
  otherQuotes: { treatment: string; cycle: number; statusLabel: string; total: number | null }[];

  // ── Clinical context on record ──
  // The CRM holds NO structured medical history (no conditions, allergies, medications
  // or intake questionnaire exist in the schema). What follows is everything with any
  // clinical bearing that IS recorded; `hasStructuredMedicalHistory` stays false so the
  // PDF can say so plainly rather than implying a medical record exists.
  hasStructuredMedicalHistory: false;
  statedInterest: string | null;
  askedFor: string | null;
  safetyFlags: string[];
  clinicalConsent: "given" | "assumed" | "withheld";
  protectionNote: string | null;
  /// Clinical notes from the post-sales journey for this quote, if it has opened one.
  clinicalNotes: { at: Date; author: string; body: string }[];

  // ── Conversations + contact log ──
  calls: CallRecord[];
  timeline: ContactEvent[];
  counts: { calls: number; messagesIn: number; messagesOut: number; notes: number; checkIns: number };
};

/// Short human reference for the record, matching the quote PDF's convention.
function refFor(quoteId: string, cycle: number): string {
  return `Q-${quoteId.slice(-6).toUpperCase()}${cycle > 1 ? `-C${cycle}` : ""}`;
}

function secs(n: number | null): string {
  if (n == null) return "—";
  const m = Math.floor(n / 60);
  return m > 0 ? `${m}m ${n % 60}s` : `${n}s`;
}

/// Trim a message body to one timeline line without losing the sense of it.
function oneLine(s: string | null, max = 140): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "(no text)";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/// Assemble the whole record for one converted quote. Returns null if the quote (or
/// its lead) doesn't exist. Deliberately does NOT check permissions — the route does.
export async function getPatientHistory(quoteId: string): Promise<PatientHistory | null> {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    include: {
      ownerRep: { select: { name: true } },
      branch: { select: { name: true } },
      invoicedBranch: { select: { name: true } },
      versions: { orderBy: { createdAt: "asc" }, select: { price: true, note: true, createdAt: true } },
      journey: {
        select: {
          notes: {
            where: { kind: "clinical" },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true, authorName: true, body: true },
          },
        },
      },
      lead: {
        include: {
          assignedRep: { select: { name: true } },
          calls: {
            orderBy: { createdAt: "asc" },
            include: { handledBy: { select: { name: true } } },
          },
          messages: { orderBy: { createdAt: "asc" } },
          comments: { orderBy: { createdAt: "asc" } },
          followUpSteps: { orderBy: { createdAt: "asc" }, include: { ownerRep: { select: { name: true } } } },
          postSalesCheckIns: { orderBy: { scheduledFor: "asc" } },
          quotes: { orderBy: { createdAt: "asc" }, select: { id: true, treatment: true, cycle: true, status: true, totalPayable: true } },
        },
      },
    },
  });
  if (!quote) return null;
  const lead = quote.lead;

  const totals = computeQuoteTotals({
    base: quote.price,
    gstRate: quote.gstRate,
    discountType: quote.discountType,
    discountValue: quote.discountValue,
  });
  const discountLabel =
    quote.discountType && quote.discountValue
      ? `${quote.discountType === "percent" ? `${quote.discountValue}%` : `Rs. ${quote.discountValue.toLocaleString("en-IN")}`} (-Rs. ${totals.discountAmount.toLocaleString("en-IN")})`
      : null;

  // ── Safety flags: the same set the clinical handover surfaces (§compliance). ──
  const safetyFlags: string[] = [];
  if (lead.possibleMinor) safetyFlags.push("Possibly a minor — guardian consent required");
  if (lead.hearingImpaired) safetyFlags.push("Hearing impaired — do not phone, use WhatsApp");
  if (lead.legalThreatFreeze) safetyFlags.push("Legal-threat freeze — no automated contact");
  if (lead.complaintOpen) safetyFlags.push("Open complaint — handle personally");
  if (lead.onDnd) safetyFlags.push("On the Do-Not-Call registry");
  if (lead.optedOut) safetyFlags.push("Opted out of sales/marketing outreach");

  const calls: CallRecord[] = lead.calls.map((c) => {
    const b = (c.cqsBreakdown ?? null) as { summary?: unknown; objection_type?: unknown } | null;
    return {
      at: c.createdAt,
      type: c.callType,
      outcome: c.outcome,
      sentiment: c.sentiment,
      durationSec: c.duration,
      cqs: c.cqs,
      cqsSummary: typeof b?.summary === "string" ? b.summary : null,
      objection: typeof b?.objection_type === "string" ? b.objection_type : null,
      handledBy: c.handledBy?.name ?? null,
      recordingConsent: c.recordingConsent,
      transcript: c.transcript,
    };
  });

  // ── One chronological log of every contact, whatever the channel. ──
  const timeline: ContactEvent[] = [];

  for (const c of calls) {
    timeline.push({
      at: c.at,
      kind: "call",
      channel: c.type === "human_handover" ? "Human call" : "AI call",
      summary: c.cqsSummary ?? `${c.type.replace(/_/g, " ")} call`,
      actor: c.handledBy,
      detail: [
        c.outcome ? `outcome: ${c.outcome}` : null,
        c.sentiment ? `sentiment: ${c.sentiment}` : null,
        `duration: ${secs(c.durationSec)}`,
        c.cqs != null ? `CQS ${c.cqs}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  for (const m of lead.messages) {
    const inbound = m.direction === "inbound";
    timeline.push({
      at: m.createdAt,
      kind: inbound ? "whatsapp_in" : "whatsapp_out",
      channel: inbound ? "WhatsApp in" : "WhatsApp out",
      summary: m.type === "text" ? oneLine(m.body) : `[${m.type}] ${oneLine(m.body, 100)}`,
      actor: inbound ? null : (m.sentBy ?? (m.automated ? "automated" : null)),
      detail: [m.templateName ? `template: ${m.templateName}` : null, m.status ? `status: ${m.status}` : null, m.error]
        .filter(Boolean)
        .join(" · ") || null,
    });
  }

  for (const n of lead.comments) {
    timeline.push({
      at: n.createdAt,
      kind: "note",
      channel: "Staff note",
      summary: oneLine(n.body, 200),
      actor: n.authorName,
      detail: null,
    });
  }

  // Only follow-up steps that actually HAPPENED are contact; pending ones are plans.
  for (const s of lead.followUpSteps) {
    if (s.status !== "done") continue;
    timeline.push({
      at: s.completedAt ?? s.updatedAt,
      kind: "follow_up",
      channel: "Follow-up",
      summary: s.title,
      actor: s.ownerKind === "ai" ? "AI" : (s.ownerRep?.name ?? null),
      detail: [`channel: ${s.channel}`, s.note].filter(Boolean).join(" · ") || null,
    });
  }

  for (const c of lead.postSalesCheckIns) {
    if (c.status === "pending" || c.status === "skipped") continue;
    timeline.push({
      at: c.sentAt ?? c.scheduledFor,
      kind: "check_in",
      channel: "Care check-in",
      summary: `Day ${c.dayOffset} post-op check-in`,
      actor: null,
      detail: [`status: ${c.status}`, c.blockedReason].filter(Boolean).join(" · ") || null,
    });
  }

  // The quotation itself is a contact event — the patient was given a price.
  timeline.push({
    at: quote.createdAt,
    kind: "quote",
    channel: "Quotation",
    summary: `${quote.treatment} quoted at Rs. ${(quote.totalPayable ?? totals.total).toLocaleString("en-IN")}`,
    actor: quote.ownerRep?.name ?? null,
    detail: `ref: ${refFor(quote.id, quote.cycle)}`,
  });
  if (quote.convertedAt) {
    timeline.push({
      at: quote.convertedAt,
      kind: "quote",
      channel: "Conversion",
      summary: `${quote.treatment} converted`,
      actor: quote.ownerRep?.name ?? null,
      detail: `Rs. ${(quote.totalPayable ?? totals.total).toLocaleString("en-IN")}`,
    });
  }

  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    generatedAt: new Date(),

    leadId: lead.id,
    patientName: lead.name,
    patientPhone: lead.phone,
    patientEmail: lead.email,
    leadStageLabel: stageLabel(lead.stage),
    leadCreatedAt: lead.createdAt,
    source: lead.source,
    campaign: lead.campaign,
    preferredLanguage: lead.preferredLanguage,

    quoteOwner: quote.ownerRep?.name ?? null,
    leadOwner: lead.assignedRep?.name ?? null,

    quoteId: quote.id,
    quoteRef: refFor(quote.id, quote.cycle),
    treatment: quote.treatment,
    cycle: quote.cycle,
    quoteStatusLabel: QUOTE_STATUS_LABELS[quote.status as QuoteStatus] ?? quote.status,
    quoteSourceLabel: quote.source ? (QUOTE_SOURCE_LABELS[quote.source as QuoteSource] ?? quote.source) : null,
    base: totals.base,
    discountLabel,
    discountAmount: totals.discountAmount,
    gstRate: totals.gstRate,
    gstAmount: totals.gstAmount,
    total: quote.totalPayable ?? totals.total,
    quotedAt: quote.createdAt,
    convertedAt: quote.convertedAt,
    raisedBranch: quote.branch?.name ?? null,
    invoicedBranch: quote.invoicedBranch?.name ?? null,
    priceTrail: quote.versions.map((v, i) => ({
      at: v.createdAt,
      price: v.price,
      note: v.note,
      opening: i === 0,
    })),
    otherQuotes: lead.quotes
      .filter((q) => q.id !== quote.id)
      .map((q) => ({
        treatment: q.treatment,
        cycle: q.cycle,
        statusLabel: QUOTE_STATUS_LABELS[q.status as QuoteStatus] ?? q.status,
        total: q.totalPayable,
      })),

    hasStructuredMedicalHistory: false,
    statedInterest: lead.interest,
    askedFor: lead.tag,
    safetyFlags,
    clinicalConsent:
      lead.consentClinical === true ? "given" : lead.consentClinical === false ? "withheld" : "assumed",
    protectionNote: lead.protectionNote,
    clinicalNotes: (quote.journey?.notes ?? []).map((n) => ({
      at: n.createdAt,
      author: n.authorName ?? "—",
      body: n.body,
    })),

    calls,
    timeline,
    counts: {
      calls: calls.length,
      messagesIn: lead.messages.filter((m) => m.direction === "inbound").length,
      messagesOut: lead.messages.filter((m) => m.direction !== "inbound").length,
      notes: lead.comments.length,
      checkIns: lead.postSalesCheckIns.length,
    },
  };
}
