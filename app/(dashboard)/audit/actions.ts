"use server";

// Verify the audit log's tamper-evident hash chain (§compliance). Gated to audit.view.
// On a broken chain (i.e. someone edited/removed a row out-of-band, past the DB
// append-only trigger) it fires an immediate Slack alert.
import { requireCapability } from "@/lib/authz";
import { verifyAuditChain, type ChainResult } from "@/lib/audit";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { logger } from "@/lib/logger";

export async function verifyAuditIntegrityAction(): Promise<ChainResult> {
  const user = await requireCapability("audit.view");
  const res = await verifyAuditChain();
  if (!res.ok) {
    logger.error(`AUDIT INTEGRITY FAILURE detected by ${user.email}: ${JSON.stringify(res.brokenAt)}`);
    if (isSlackConfigured()) {
      await sendSlack({
        text:
          `🚨 *AUDIT LOG INTEGRITY FAILURE* — the tamper-evident chain is broken.\n` +
          `First break at *${res.brokenAt?.action}* (${res.brokenAt?.at}): ${res.brokenAt?.reason}.\n` +
          `Verified ${res.checked} entries before the break. Detected by ${user.email}.`,
      }).catch(() => {});
    }
  }
  return res;
}
