// Streams a quote's PDF (§multi-quote). Session-gated to `quotes.view` AND scoped by
// lead ownership, so a front-desk/telecaller can't pull a PDF for a lead they can't
// see. Rendered on demand — nothing is stored. Used by the "PDF" link and reused by
// the WhatsApp/email send actions.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser, canSeeLead } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { buildQuotePdf, quoteRef } from "@/lib/quotePdf";
import { getBranchQuoteInfo } from "@/lib/branches";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(user.role, "quotes.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { lead: { select: { name: true, phone: true, assignedRepId: true, createdById: true } } },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canSeeLead(user, quote.lead)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pdf = await buildQuotePdf({
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

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${quoteRef(quote.id, quote.cycle)}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
