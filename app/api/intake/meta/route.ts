// Meta (Facebook + Instagram) Lead Ads webhook.
//   GET  → subscription verification handshake (hub.challenge)
//   POST → leadgen notifications: verify signature, fetch each lead from the
//          Graph API, normalise, and ingest.
// Configure this URL as the webhook callback for the `leadgen` field in your
// Meta app, with verify token = META_VERIFY_TOKEN.
import { NextResponse } from "next/server";
import { metaLeadgenWebhookSchema } from "@/lib/contracts";
import { ingestLead } from "@/lib/leadIntake";
import {
  verifyMetaSignature,
  fetchMetaLead,
  mapMetaLead,
  handleMetaVerification,
} from "@/lib/providers/meta";
import { logger } from "@/lib/logger";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const { status, body } = handleMetaVerification(searchParams);
  return new NextResponse(body, { status });
}

export async function POST(req: Request) {
  // Read the RAW body first — signature must be checked against exact bytes.
  const raw = await req.text();
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const parsed = metaLeadgenWebhookSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let processed = 0;
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "leadgen") continue;
      const { leadgen_id, ad_id } = change.value;
      try {
        const graphLead = await fetchMetaLead(leadgen_id);
        const normalized = mapMetaLead(graphLead, ad_id);
        if (!normalized.phone) {
          logger.warn(`Meta lead ${leadgen_id} has no phone — skipping call trigger`);
        }
        await ingestLead(normalized);
        processed++;
      } catch (err) {
        // Log and continue; never 500 back to Meta (it would retry endlessly).
        logger.error(`Failed to process Meta leadgen ${leadgen_id}: ${String(err)}`);
      }
    }
  }

  // Always 200 so Meta marks delivery successful.
  return NextResponse.json({ ok: true, processed }, { status: 200 });
}
