// Internal patient history PDF (§multi-quote → conversion). Renders the record
// assembled by lib/patientHistory.ts as a multi-page A4 document, using pdfkit's
// built-in fonts — no browser, no external assets, nothing stored on disk.
//
// ⚠️ CONFIDENTIAL: this document contains full call transcripts and the entire
// WhatsApp thread. It is stamped INTERNAL on every page for exactly that reason.
// The route that serves it is gated on `calls.view` + `quotes.view` and audited.
//
// pdfkit's standard WinAnsi fonts can't render the ₹ glyph or an em-dash, so money is
// written "Rs." and separators are plain hyphens — same convention as lib/quotePdf.ts.
import PDFDocument from "pdfkit";
import type { PatientHistory } from "@/lib/patientHistory";

const CLINIC_NAME = process.env.CLINIC_NAME ?? "Cara Clinic";

/// Longest transcript rendered per call before it is cut. A full-length consultation
/// transcript can run to thousands of words; past this the document stops being a
/// summary. Truncation is always stated in the output, never silent.
const TRANSCRIPT_MAX = 6000;

function rs(n: number | null | undefined): string {
  return `Rs. ${Math.round(n ?? 0).toLocaleString("en-IN")}`;
}

function istDateTime(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "Asia/Kolkata",
  }).format(d);
}

function istDate(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  }).format(d);
}

/// Strip characters the built-in WinAnsi fonts can't encode, so a stray emoji in a
/// WhatsApp message can't throw mid-render.
function safe(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/₹/g, "Rs.")
    .replace(/[^\x20-\x7E\n\r\t]/g, "");
}

export function buildPatientHistoryPdf(h: PatientHistory): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;
    const bottom = doc.page.height - 60;

    /// Start a new page when `need` points won't fit above the footer band.
    const room = (need: number) => {
      if (doc.y + need > bottom) doc.addPage();
    };

    const heading = (t: string) => {
      room(46);
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text(safe(t), left, doc.y, { width });
      const y = doc.y + 3;
      doc.moveTo(left, y).lineTo(right, y).strokeColor("#ccc").lineWidth(1).stroke();
      doc.y = y + 8;
    };

    /// A label/value pair laid out in `cols` columns across the content width.
    const grid = (pairs: [string, string][], cols = 3) => {
      const colW = width / cols;
      for (let i = 0; i < pairs.length; i += cols) {
        const rowPairs = pairs.slice(i, i + cols);
        room(34);
        const y0 = doc.y;
        let maxY = y0;
        rowPairs.forEach(([label, val], j) => {
          const x = left + colW * j;
          doc.font("Helvetica").fontSize(7.5).fillColor("#888")
            .text(safe(label).toUpperCase(), x, y0, { width: colW - 10 });
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111")
            .text(safe(val) || "-", x, y0 + 11, { width: colW - 10 });
          maxY = Math.max(maxY, doc.y);
        });
        doc.y = maxY + 6;
      }
    };

    const para = (t: string, opts?: { size?: number; color?: string; indent?: number }) => {
      const size = opts?.size ?? 9.5;
      const x = left + (opts?.indent ?? 0);
      const w = width - (opts?.indent ?? 0);
      room(size * 2.2);
      doc.font("Helvetica").fontSize(size).fillColor(opts?.color ?? "#222")
        .text(safe(t), x, doc.y, { width: w, align: "left" });
      doc.y += 2;
    };

    const bullet = (t: string) => {
      room(16);
      doc.font("Helvetica").fontSize(9.5).fillColor("#222")
        .text(`- ${safe(t)}`, left + 8, doc.y, { width: width - 8 });
      doc.y += 1;
    };

    // ── Cover block ────────────────────────────────────────────────────
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text(safe(CLINIC_NAME), left, 46, { width });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#444").text("PATIENT HISTORY SUMMARY", { width });
    doc.font("Helvetica").fontSize(8.5).fillColor("#a00")
      .text("INTERNAL USE ONLY - contains call transcripts and the full message thread. Not for the patient.", { width });
    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#999").stroke();
    doc.y += 10;

    grid([
      ["Patient", h.patientName],
      ["Phone", h.patientPhone],
      ["Record ref", h.quoteRef],
      ["Treatment", `${h.treatment}${h.cycle > 1 ? ` (session ${h.cycle})` : ""}`],
      ["Converted", h.convertedAt ? istDate(h.convertedAt) : "not converted"],
      ["Generated", istDateTime(h.generatedAt)],
    ]);

    // ── Ownership ──────────────────────────────────────────────────────
    heading("Ownership");
    grid([
      ["Quote owner (telecaller)", h.quoteOwner ?? "Unassigned"],
      ["Lead owner", h.leadOwner ?? "Unassigned"],
      ["Lead stage", h.leadStageLabel],
      ["First contact", istDate(h.leadCreatedAt)],
      ["Source", h.source ?? "-"],
      ["Campaign", h.campaign ?? "-"],
    ]);

    // ── The quotation ──────────────────────────────────────────────────
    heading("Quotation");
    grid([
      ["Status", h.quoteStatusLabel],
      ["Quoted on", istDate(h.quotedAt)],
      ["Attribution", h.quoteSourceLabel ?? "-"],
      ["Base price", rs(h.base)],
      ["Discount", h.discountLabel ?? "none"],
      [`GST (${h.gstRate}%)`, rs(h.gstAmount)],
      ["Total payable", rs(h.total)],
      ["Raised at", h.raisedBranch ?? "-"],
      ["Invoiced by", h.invoicedBranch ?? "-"],
    ]);

    if (h.priceTrail.length > 0) {
      doc.y += 2;
      para("Price trail", { size: 9, color: "#555" });
      for (const v of h.priceTrail) {
        bullet(
          `${istDate(v.at)} - ${rs(v.price)}${v.opening ? " (opening price)" : " (revised)"}${v.note ? ` - ${v.note}` : ""}`,
        );
      }
    }

    if (h.otherQuotes.length > 0) {
      doc.y += 4;
      para("Other quotes on this patient", { size: 9, color: "#555" });
      for (const q of h.otherQuotes) {
        bullet(
          `${q.treatment}${q.cycle > 1 ? ` (session ${q.cycle})` : ""} - ${q.statusLabel}${q.total != null ? ` - ${rs(q.total)}` : ""}`,
        );
      }
    }

    // ── Clinical context ───────────────────────────────────────────────
    heading("Clinical context on record");
    if (!h.hasStructuredMedicalHistory) {
      para(
        "The CRM holds no structured medical history for this patient - there is no field for conditions, allergies, medications or an intake questionnaire. Everything with a clinical bearing that IS recorded appears below; anything else lives outside this system.",
        { size: 9, color: "#a00" },
      );
      doc.y += 4;
    }
    grid(
      [
        ["Stated interest", h.statedInterest ?? "-"],
        ["Asked for", h.askedFor ?? "-"],
        ["Preferred language", h.preferredLanguage ?? "not recorded"],
        ["Clinical consent", h.clinicalConsent],
      ],
      2,
    );
    if (h.safetyFlags.length > 0) {
      doc.y += 2;
      para("Safety flags", { size: 9, color: "#555" });
      for (const f of h.safetyFlags) bullet(f);
    }
    if (h.protectionNote) para(`Protection note: ${h.protectionNote}`, { size: 9, color: "#555" });
    if (h.clinicalNotes.length > 0) {
      doc.y += 4;
      para("Clinical notes from the post-sales journey", { size: 9, color: "#555" });
      for (const n of h.clinicalNotes) {
        bullet(`${istDate(n.at)} - ${n.author}: ${n.body}`);
      }
    }

    // ── Conversations ──────────────────────────────────────────────────
    heading("Conversations");
    para(
      `${h.counts.calls} call(s) - ${h.counts.messagesIn} inbound and ${h.counts.messagesOut} outbound WhatsApp messages - ${h.counts.notes} staff note(s) - ${h.counts.checkIns} care check-in(s).`,
      { size: 9, color: "#555" },
    );
    doc.y += 4;

    if (h.calls.length === 0) {
      para("No calls recorded.", { size: 9, color: "#777" });
    } else {
      for (const c of h.calls) {
        room(56);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111")
          .text(
            safe(`${istDateTime(c.at)} - ${c.type.replace(/_/g, " ")}${c.handledBy ? ` - ${c.handledBy}` : ""}`),
            left, doc.y, { width },
          );
        const facts = [
          c.outcome ? `outcome: ${c.outcome}` : null,
          c.sentiment ? `sentiment: ${c.sentiment}` : null,
          c.durationSec != null ? `duration: ${c.durationSec}s` : null,
          c.cqs != null ? `CQS: ${c.cqs}` : null,
          c.objection ? `objection: ${c.objection}` : null,
          c.recordingConsent == null ? null : `recording consent: ${c.recordingConsent ? "yes" : "no"}`,
        ].filter(Boolean).join("  |  ");
        if (facts) para(facts, { size: 8.5, color: "#666" });
        if (c.cqsSummary) para(c.cqsSummary, { size: 9 });
        doc.y += 6;
      }
    }

    // ── Full contact log ───────────────────────────────────────────────
    heading("Every contact, in order");
    if (h.timeline.length === 0) {
      para("Nothing recorded.", { size: 9, color: "#777" });
    } else {
      const whenW = 108;
      const chanW = 78;
      for (const e of h.timeline) {
        room(26);
        const y0 = doc.y;
        doc.font("Helvetica").fontSize(8).fillColor("#666")
          .text(safe(istDateTime(e.at)), left, y0, { width: whenW - 6 });
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#444")
          .text(safe(e.channel), left + whenW, y0, { width: chanW - 6 });
        const textX = left + whenW + chanW;
        const textW = width - whenW - chanW;
        doc.font("Helvetica").fontSize(9).fillColor("#111")
          .text(safe(e.summary), textX, y0, { width: textW });
        const sub = [e.actor, e.detail].filter(Boolean).join(" - ");
        if (sub) {
          doc.font("Helvetica").fontSize(7.5).fillColor("#888")
            .text(safe(sub), textX, doc.y, { width: textW });
        }
        doc.y = Math.max(doc.y, y0 + 14) + 4;
      }
    }

    // ── Transcripts ────────────────────────────────────────────────────
    const withTranscript = h.calls.filter((c) => c.transcript?.trim());
    if (withTranscript.length > 0) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Call transcripts", left, doc.y, { width });
      doc.font("Helvetica").fontSize(8.5).fillColor("#a00")
        .text("Verbatim. Do not share outside the clinic.", { width });
      doc.y += 8;

      for (const c of withTranscript) {
        room(60);
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111")
          .text(safe(`${istDateTime(c.at)} - ${c.type.replace(/_/g, " ")}${c.handledBy ? ` - ${c.handledBy}` : ""}`), left, doc.y, { width });
        doc.y += 2;
        const full = c.transcript!.trim();
        const shown = full.length > TRANSCRIPT_MAX ? full.slice(0, TRANSCRIPT_MAX) : full;
        doc.font("Helvetica").fontSize(8.5).fillColor("#222")
          .text(safe(shown), left, doc.y, { width, align: "left" });
        if (full.length > TRANSCRIPT_MAX) {
          doc.font("Helvetica-Oblique").fontSize(8).fillColor("#a00")
            .text(
              safe(`[transcript truncated - ${full.length - TRANSCRIPT_MAX} more characters in the CRM]`),
              left, doc.y + 2, { width },
            );
        }
        doc.y += 12;
      }
    }

    // ── Page furniture, stamped once at the end so totals are known ────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // The footer sits BELOW the bottom margin. Without dropping the margin first,
      // pdfkit treats each footer write as overflow and auto-appends a fresh page —
      // which then has no footer of its own, and the document silently triples.
      doc.page.margins.bottom = 0;
      const fy = doc.page.height - 42;
      doc.moveTo(left, fy - 6).lineTo(right, fy - 6).strokeColor("#eee").lineWidth(1).stroke();
      doc.font("Helvetica").fontSize(7.5).fillColor("#999")
        .text(
          safe(`INTERNAL - ${h.patientName} - ${h.quoteRef} - generated ${istDateTime(h.generatedAt)}`),
          left, fy, { width: width - 60, lineBreak: false },
        );
      doc.font("Helvetica").fontSize(7.5).fillColor("#999")
        .text(`${i - range.start + 1} / ${range.count}`, right - 60, fy, { width: 60, align: "right", lineBreak: false });
    }

    doc.end();
  });
}
