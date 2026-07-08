// Lead CRUD. (Guide §5: app/api/leads/route.ts)
// POST creates a lead and fires n8n Agent 1 to place the initial AI call.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLeadSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";
import { requireSession } from "@/lib/apiAuth";

export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;

  const leads = await prisma.lead.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { calls: { orderBy: { createdAt: "desc" } } },
  });
  return NextResponse.json(leads);
}

export async function POST(req: Request) {
  // Staff-only: this also fires a (paid) outbound AI call via n8n Agent 1, so
  // it must never be open. External lead sources use /api/intake/* (honeypot /
  // signature / key gated) or /api/webhooks/lead-created (shared secret).
  const denied = await requireSession();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = createLeadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { lead, deduped } = await ingestLead({
    ...parsed.data,
    source: parsed.data.source ?? "manual",
  });

  return NextResponse.json(lead, { status: deduped ? 200 : 201 });
}
