// Ad platform → CRM: what we spent yesterday (§reports, Source Attribution).
//
// The cost side of attribution has to come from outside — nothing in the CRM knows what
// a click cost. Post one day's spend per source (or a batch of them) and the report can
// state cost per lead, per consultation and per surgery.
//
// **Send a 0 for a day with no spend.** A day nobody posts is treated as unknown and
// every cost figure covering it is withheld, which is deliberate: a missing day silently
// counted as zero would make a channel look cheaper than it is and move budget toward it.
//
// Authenticated with the shared secret (`x-webhook-secret`), like the invoice webhook.
// Re-posting a day REPLACES it, because the platforms restate spend for a day or two.
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyWebhookSecret } from "@/lib/verify";
import { recordAdSpend, AdSpendError } from "@/lib/adSpend";
import { PAID_SOURCES } from "@/lib/reports/shared";
import { logger } from "@/lib/logger";

const entry = z.object({
  /// IST calendar day this spend belongs to, "YYYY-MM-DD".
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD"),
  /// facebook | instagram | google — must match the lead source it bought.
  source: z.string().min(1),
  /// Platform campaign id/name. Omit for the source's daily total.
  campaign: z.string().optional(),
  /// Whole rupees. Zero is a valid, meaningful value.
  amount: z.number().nonnegative(),
  currency: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  note: z.string().optional(),
});

/// Accepts one entry or `{ entries: [...] }` — a daily job usually posts a batch.
const schema = z.union([entry, z.object({ entries: z.array(entry).min(1).max(500) })]);

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) {
    logger.warn("Ad-spend webhook: bad or missing shared secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    logger.warn(`Ad-spend webhook rejected: ${detail}`);
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  const entries = "entries" in parsed.data ? parsed.data.entries : [parsed.data];
  const source = req.headers.get("x-spend-source")?.trim() || "webhook";

  let created = 0;
  let replaced = 0;
  const failed: { day: string; source: string; error: string }[] = [];

  for (const e of entries) {
    try {
      const res = await recordAdSpend({ ...e, importedFrom: source });
      if (res.replaced) replaced += 1;
      else created += 1;
    } catch (err) {
      if (err instanceof AdSpendError) failed.push({ day: e.day, source: e.source, error: err.message });
      else throw err;
    }
  }

  if (failed.length === entries.length) {
    // Nothing landed — the sender's payload is wrong, so it gets a 422 and the reasons
    // rather than a retry loop.
    return NextResponse.json(
      { error: "No entries could be recorded", failed, paidSources: PAID_SOURCES },
      { status: 422 },
    );
  }

  if (failed.length > 0) {
    logger.warn(`Ad-spend webhook: ${failed.length} of ${entries.length} entries rejected`);
  }
  logger.info(`Ad-spend webhook: ${created} recorded, ${replaced} replaced, ${failed.length} rejected`);
  return NextResponse.json(
    { ok: true, created, replaced, ...(failed.length ? { failed } : {}) },
    { status: created > 0 ? 201 : 200 },
  );
}
