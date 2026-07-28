"use server";

// Dead-Lead review queue actions (§follow-up). A Sales Head / Telecalling Head approves
// Lost leads for one more automated try — the dead_lead_bulk campaign — singly or in a batch.
// Gated to `campaigns.winback`; each approval is audited with the approver.
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { enrollLead } from "@/lib/campaigns/engine";
import { logger } from "@/lib/logger";

export type ApproveResult = {
  ok: boolean;
  enrolled: number;
  skipped: { id: string; reason: string }[];
  error?: string;
};

/// Approve one or more Lost leads for the dead_lead_bulk "one more try" campaign.
export async function approveLeadsForRetry(leadIds: string[]): Promise<ApproveResult> {
  const actor = await requireCapability("campaigns.winback");
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (ids.length === 0) return { ok: false, enrolled: 0, skipped: [], error: "No leads selected" };

  let enrolled = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const res = await enrollLead(id, "dead_lead_bulk");
    if (res.ok) {
      enrolled++;
      await writeAudit({
        actorId: actor.id, actorEmail: actor.email, action: "lead.campaign.approve",
        entityType: "lead", entityId: id, newValue: "Dead Lead Bulk", reason: "Approved for one more try",
      });
    } else {
      skipped.push({ id, reason: res.reason });
    }
  }
  logger.info(`Dead-lead approval by ${actor.email}: ${enrolled} enrolled, ${skipped.length} skipped`);
  revalidatePath("/win-back");
  return { ok: enrolled > 0, enrolled, skipped };
}
