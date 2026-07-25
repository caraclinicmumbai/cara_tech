"use server";

// Server Actions for lead handover + temporary access grants (§handover). Each
// re-checks the caller's capability and (for handover) lead visibility, then delegates
// to lib/leadOwnership which enforces the owner/manager + cross-branch rules and writes
// the audit trail. Grant/revoke are gated to leads.grantAccess (managers/admin).
import { revalidatePath } from "next/cache";
import { requireCapability, userCanAccessLead } from "@/lib/authz";
import { leadScope } from "@/lib/rbac";
import { handoverLead, grantLeadAccess, revokeLeadAccess, OwnershipError } from "@/lib/leadOwnership";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string; info?: string };

export async function handoverLeadAction(input: {
  leadId: string;
  toRepId: string;
  reason?: string | null;
}): Promise<Result> {
  const user = await requireCapability("leads.handover");
  if (!(await userCanAccessLead(user, input.leadId))) return { ok: false, error: "Not found" };

  try {
    const { crossBranch, toRepName } = await handoverLead({
      leadId: input.leadId,
      toRepId: input.toRepId,
      reason: input.reason,
      actor: { id: user.id, email: user.email, salesRepId: user.salesRepId, isManager: leadScope(user.role) === "all" },
    });
    revalidatePath(`/leads/${input.leadId}`);
    revalidatePath("/leads");
    return { ok: true, info: `Handed over to ${toRepName}${crossBranch ? " (cross-branch)" : ""}` };
  } catch (err) {
    if (err instanceof OwnershipError) return { ok: false, error: err.message };
    logger.error(`handoverLeadAction failed for ${input.leadId}: ${String(err)}`);
    return { ok: false, error: "Could not hand over the lead" };
  }
}

export async function grantLeadAccessAction(input: {
  leadId: string;
  granteeUserId: string;
  reason?: string | null;
  durationDays?: number | null;
}): Promise<Result> {
  const user = await requireCapability("leads.grantAccess");
  try {
    await grantLeadAccess({
      leadId: input.leadId,
      granteeUserId: input.granteeUserId,
      reason: input.reason,
      durationDays: input.durationDays,
      actor: { id: user.id, email: user.email },
    });
    revalidatePath(`/leads/${input.leadId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof OwnershipError) return { ok: false, error: err.message };
    logger.error(`grantLeadAccessAction failed for ${input.leadId}: ${String(err)}`);
    return { ok: false, error: "Could not grant access" };
  }
}

export async function revokeLeadAccessAction(input: { grantId: string; leadId: string }): Promise<Result> {
  const user = await requireCapability("leads.grantAccess");
  try {
    await revokeLeadAccess({ grantId: input.grantId, actor: { id: user.id, email: user.email } });
    revalidatePath(`/leads/${input.leadId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof OwnershipError) return { ok: false, error: err.message };
    logger.error(`revokeLeadAccessAction failed for ${input.grantId}: ${String(err)}`);
    return { ok: false, error: "Could not revoke access" };
  }
}
