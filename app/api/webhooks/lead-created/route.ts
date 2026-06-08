// Generic normalised lead webhook (e.g. from n8n or another internal tool).
// Secret-gated. For source-specific intake use /api/intake/{web-form,meta,google}.
// (Guide §5 — "Fires n8n Agent 1")
import { NextResponse } from "next/server";
import { createLeadSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";
import { verifyWebhookSecret } from "@/lib/verify";

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    source: parsed.data.source ?? "web_form",
  });

  return NextResponse.json({ leadId: lead.id, deduped }, { status: deduped ? 200 : 201 });
}
