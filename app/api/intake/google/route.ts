// Google Ads Lead Form webhook. Google POSTs lead data directly here with a
// shared `google_key`. Configure this URL + key in the Google Ads lead form's
// "Webhook integration" (Delivery) settings.
import { NextResponse } from "next/server";
import { googleLeadFormSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";
import { verifyGoogleKey, mapGoogleLead } from "@/lib/providers/google";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = googleLeadFormSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (!verifyGoogleKey(parsed.data.google_key)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 401 });
  }

  // Google's "Send test lead" button posts is_test=true — acknowledge, don't store.
  if (parsed.data.is_test) {
    logger.info("Google lead-form test ping received");
    return NextResponse.json({ ok: true, test: true }, { status: 200 });
  }

  const normalized = mapGoogleLead(parsed.data);
  const { lead, deduped } = await ingestLead(normalized);

  return NextResponse.json({ leadId: lead.id, deduped }, { status: deduped ? 200 : 201 });
}
