// Streams the internal patient history PDF for a CONVERTED quote (§multi-quote →
// conversion). Rendered on demand — nothing is stored.
//
// This document carries full call transcripts and the entire WhatsApp thread, so it is
// gated harder than the quote PDF:
//   • `quotes.view`  — the quotation section
//   • `calls.view`   — the conversations, transcripts and CQS
//   • lead ownership — a scoped counsellor can't pull a lead they can't see
// The clinical roles (doctor / ot_team / post_sales_consultant) hold NEITHER capability,
// which is what keeps the ERP's "summary, not recordings" rule intact (§post-sales).
//
// Only a converted quote has a history record: before conversion the lead's own page is
// the live view, and a history PDF of an open quote would read as a closed file.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser, userCanAccessLead } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { WON_QUOTE_STATUSES } from "@/lib/quoteStages";
import { getPatientHistory } from "@/lib/patientHistory";
import { buildPatientHistoryPdf } from "@/lib/historyPdf";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(user.role, "quotes.view") || !can(user.role, "calls.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    select: { id: true, leadId: true, status: true },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await userCanAccessLead(user, quote.leadId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(WON_QUOTE_STATUSES as string[]).includes(quote.status)) {
    return NextResponse.json(
      { error: "A history summary is only available once the quote has converted." },
      { status: 409 },
    );
  }

  const history = await getPatientHistory(quote.id);
  if (!history) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let pdf: Buffer;
  try {
    pdf = await buildPatientHistoryPdf(history);
  } catch (err) {
    logger.error(`Patient history PDF build failed for quote ${quote.id}: ${String(err)}`);
    return NextResponse.json({ error: "Could not generate the history summary" }, { status: 500 });
  }

  // Record-view (§compliance). This one matters more than most: it logs who pulled a
  // patient's transcripts and full message thread, and how much of it they got.
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "record.view",
    entityType: "quote",
    entityId: quote.id,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null,
    userAgent: req.headers.get("user-agent"),
    meta: {
      historyPdf: true,
      leadId: quote.leadId,
      calls: history.counts.calls,
      messages: history.counts.messagesIn + history.counts.messagesOut,
      transcripts: history.calls.filter((c) => !!c.transcript?.trim()).length,
    },
  });

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${history.quoteRef}-history.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
