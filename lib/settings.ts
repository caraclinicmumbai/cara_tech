// Admin-editable operating switches (§settings).
//
// These are the rules the clinic changes as the business changes — distinct from
// environment config, which needs a redeploy and a developer. "Billing has gone live,
// start requiring invoices" is a decision the person running the clinic should be able
// to make on a Tuesday afternoon, so it lives here rather than in an env var.
//
// Every setting declares its own default, so a fresh database behaves correctly with no
// rows at all, and a key nobody has touched can't be in an undefined state.
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/// Allow a quote to be marked Converted without an invoice behind it.
///
/// §billing says conversion means an invoice exists for THAT quote — that's what keeps
/// branch credit honest, because nobody types it. But the billing system isn't wired to
/// the CRM yet, so enforcing it would leave the clinic unable to record real sales. The
/// switch exists so the rule can be turned on the day billing goes live, without a code
/// change, and so that the period when it was off is visible rather than assumed.
///
/// Conversions made while this is on are still fully recorded — audited, marked as not
/// invoice-backed, and asked which branch earns the credit.
export const ALLOW_UNINVOICED_CONVERSION = "quotes.allowUninvoicedConversion";

/// Defaults for every known key. Chosen for TODAY: billing isn't connected, so the
/// permissive value ships on. When billing is live an admin turns it off and the
/// invoice rule takes over.
const DEFAULTS: Record<string, unknown> = {
  [ALLOW_UNINVOICED_CONVERSION]: true,
};

// Settings are read on hot paths (every quote transition), change rarely, and are
// edited by one admin at a time — so a short in-process cache is worth far more than
// perfect immediacy. `invalidateSettings()` clears it on write, which covers the only
// case that matters in a single-instance deploy; a second instance picks the change up
// within the TTL.
const TTL_MS = 30_000;
let cache: { at: number; values: Map<string, unknown> } | null = null;

async function load(): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const values = new Map<string, unknown>();
  try {
    const rows = await prisma.appSetting.findMany({ select: { key: true, value: true } });
    for (const r of rows) values.set(r.key, r.value);
  } catch (err) {
    // A settings read must never take a page down: fall back to defaults and say so.
    logger.error(`Could not read app settings, using defaults: ${String(err)}`);
  }
  cache = { at: Date.now(), values };
  return values;
}

export function invalidateSettings(): void {
  cache = null;
}

/// Read a boolean setting, falling back to its declared default.
export async function getBoolSetting(key: string): Promise<boolean> {
  const values = await load();
  const raw = values.has(key) ? values.get(key) : DEFAULTS[key];
  return raw === true;
}

/// Write a setting and drop the cache. The caller writes the audit entry — this module
/// deliberately doesn't, so the audit row can carry the actor and a reason in the
/// vocabulary of whatever screen made the change.
export async function setBoolSetting(
  key: string,
  value: boolean,
  updatedById?: string | null,
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updatedById: updatedById ?? null },
    update: { value, updatedById: updatedById ?? null },
  });
  invalidateSettings();
  logger.info(`App setting ${key} set to ${value}`);
}

/// Convenience for the quote path, which asks this on every conversion attempt.
export async function uninvoicedConversionAllowed(): Promise<boolean> {
  return getBoolSetting(ALLOW_UNINVOICED_CONVERSION);
}
