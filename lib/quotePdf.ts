// Quote PDF generator (§multi-quote — "the counsellor sends it from inside the lead
// record"). Renders a one-page treatment quotation from a quote + its lead, using
// pdfkit's built-in fonts (no browser, no external assets). Amounts use "Rs." rather
// than the ₹ glyph, which pdfkit's standard WinAnsi fonts can't render.
import { existsSync } from "fs";
import { join } from "path";
import PDFDocument from "pdfkit";
import { computeQuoteTotals } from "@/lib/quoteStages";

// Clinic bank details for payment (shown on the quote PDF).
const BANK = {
  accountName: "Cara Healthcare Private Limited",
  accountNumber: "020905011291",
  ifsc: "ICIC0000209",
  branch: "Santacruz West, Linking Road, Mumbai",
};

export type QuotePdfData = {
  quoteId: string;
  treatment: string;
  cycle: number;
  price: number | null;
  gstRate: number;
  discountType: string | null;
  discountValue: number | null;
  totalPayable: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  leadName: string;
  leadPhone: string;
};

const CLINIC_NAME = process.env.CLINIC_NAME ?? "Cara Clinic";
const CLINIC_TAGLINE = process.env.CLINIC_TAGLINE ?? "Aesthetic & Hair Transplant Clinic";
const CLINIC_CONTACT = process.env.CLINIC_CONTACT ?? "";

function rs(n: number | null | undefined): string {
  return `Rs. ${Math.round(n ?? 0).toLocaleString("en-IN")}`;
}

function istDate(d: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  }).format(d);
}

/// A short, human-friendly quote reference from the cuid + cycle.
export function quoteRef(quoteId: string, cycle: number): string {
  return `Q-${quoteId.slice(-6).toUpperCase()}${cycle > 1 ? `-C${cycle}` : ""}`;
}

/// Render the quote to a PDF buffer.
export function buildQuotePdf(d: QuotePdfData): Promise<Buffer> {
  const totals = computeQuoteTotals({
    base: d.price ?? 0,
    gstRate: d.gstRate,
    discountType: d.discountType,
    discountValue: d.discountValue,
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = doc.page.width - 50;
    const width = right - left;

    // ── Header ──
    doc.fillColor("#111").font("Helvetica-Bold").fontSize(20).text(CLINIC_NAME, left, 50);
    doc.font("Helvetica").fontSize(10).fillColor("#666").text(CLINIC_TAGLINE);
    if (CLINIC_CONTACT) doc.text(CLINIC_CONTACT);
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111")
      .text("TREATMENT QUOTATION", left, 52, { width, align: "right" });

    doc.moveTo(left, 100).lineTo(right, 100).strokeColor("#ddd").stroke();

    // ── Meta + patient ──
    let y = 116;
    const label = (t: string, x: number) =>
      doc.font("Helvetica").fontSize(8).fillColor("#888").text(t.toUpperCase(), x, y);
    const value = (t: string, x: number, w: number) =>
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text(t, x, y + 11, { width: w });

    const col = width / 3;
    label("Quote No.", left); label("Date", left + col); label("Valid until", left + col * 2);
    value(quoteRef(d.quoteId, d.cycle), left, col);
    value(istDate(d.createdAt), left + col, col);
    value(d.expiresAt ? istDate(d.expiresAt) : "—", left + col * 2, col);

    y += 40;
    label("Patient", left); label("Phone", left + col);
    value(d.leadName, left, col * 2);
    value(d.leadPhone, left + col, col);

    // ── Treatment + price table ──
    y += 52;
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Treatment", left, y);
    doc.font("Helvetica").fontSize(11).text(d.treatment + (d.cycle > 1 ? `  (session ${d.cycle})` : ""), left, y + 15);

    y += 48;
    const rowH = 24;
    const amtX = right - 160;
    const row = (name: string, amount: string, opts?: { bold?: boolean; sub?: boolean }) => {
      doc.font(opts?.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts?.sub ? 9 : 11)
        .fillColor(opts?.sub ? "#777" : "#111");
      doc.text(name, left + 4, y + 6, { width: amtX - left - 8 });
      doc.text(amount, amtX, y + 6, { width: 156, align: "right" });
      y += opts?.sub ? 16 : rowH;
    };

    // Order of operations: discount applied to the base FIRST, then GST on the net.
    doc.rect(left, y, width, rowH).fill("#f4f4f4");
    doc.fillColor("#111");
    row("Base treatment price", rs(totals.base), { bold: true });
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#eee").stroke();
    if (totals.discountAmount > 0) {
      const disc = d.discountType === "percent" ? `${d.discountValue}%` : rs(d.discountValue);
      row(`Discount (${disc})`, `- ${rs(totals.discountAmount)}`);
      row("Amount after discount", rs(totals.afterDiscount), { sub: true });
    }
    row(`GST (${d.gstRate}%) on ${rs(totals.afterDiscount)}`, `+ ${rs(totals.gstAmount)}`);
    row("incl. CGST 2.5% + SGST 2.5%", "", { sub: true });
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#ccc").stroke();
    y += 4;
    doc.rect(left, y, width, rowH + 4).fill("#f0f7ff");
    doc.fillColor("#111");
    row("Total payable", rs(totals.total), { bold: true });

    // ── Payment: bank transfer + scan-to-pay QR ──
    y += 20;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text("Payment", left, y);
    y += 16;
    const qrSize = 108;
    const bankWidth = width - qrSize - 20;
    const bankLines = [
      ["Account Name", BANK.accountName],
      ["Account Number", BANK.accountNumber],
      ["IFSC Code", BANK.ifsc],
      ["Branch", BANK.branch],
    ];
    let by = y;
    for (const [label, val] of bankLines) {
      doc.font("Helvetica").fontSize(8).fillColor("#888").text(label.toUpperCase(), left, by);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(val, left, by + 10, { width: bankWidth });
      by += 30;
    }

    // Razorpay / UPI QR — embedded from public/razorpay-qr.png if present.
    const qrPath = join(process.cwd(), "public", "razorpay-qr.png");
    if (existsSync(qrPath)) {
      const qrX = right - qrSize;
      doc.image(qrPath, qrX, y, { width: qrSize, height: qrSize });
      doc.font("Helvetica").fontSize(8).fillColor("#666").text("Scan to pay", qrX, y + qrSize + 3, { width: qrSize, align: "center" });
    }

    // ── Footer note ──
    y = Math.max(by, y + qrSize) + 16;
    doc.font("Helvetica").fontSize(9).fillColor("#777").text(
      "This is a quotation, not an invoice. Amounts are inclusive of GST and valid until the date above. " +
        "Please contact the clinic to confirm and proceed with your treatment.",
      left, y, { width },
    );
    doc.fontSize(8).fillColor("#aaa").text(
      `Generated ${istDate(d.createdAt)} · ${CLINIC_NAME}`,
      left, doc.page.height - 50, { width, align: "center" },
    );

    doc.end();
  });
}
