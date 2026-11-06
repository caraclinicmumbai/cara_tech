"use server";

// Server Actions for lead handover + temporary access grants (§handover). Each
// re-checks the caller's capability and (for handover) lead visibility, then delegates
// to lib/leadOwnership which enforces the owner/manager + cross-branch rules and writes
// the audit trail. Grant/revoke are gated to leads.grantAccess (managers/admin).
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability, userCanAccessLead, leadWhereForUser } from "@/lib/authz";
import { leadScope } from "@/lib/rbac";
import {
  handoverLead,
  grantLeadAccess,
  revokeLeadAccess,
  grantBulkLeadAccess,
  revokeBulkLeadAccess,
  OwnershipError,
} from "@/lib/leadOwnership";
import { leadListWhere, parseLeadListParams } from "@/lib/leadList";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string; info?: string };

/// A handover also reports whether the caller can still SEE the lead afterwards.
/// Handing your own lead to a colleague usually costs you access, and refreshing
/// the page you're standing on would then 404 — so the panel shows a confirmation
/// instead of reloading (§handover).
type HandoverResult = Result & { lostAccess?: boolean; toRepName?: string };

export async function handoverLeadAction(input: {
  leadId: string;
  toRepId: string;
  reason?: string | null;
}): Promise<HandoverResult> {
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
    // Re-check AFTER the transfer: a manager (or someone holding a grant) keeps the
    // lead open, a line counsellor who owned it does not.
    const lostAccess = !(await userCanAccessLead(user, input.leadId));
    return {
      ok: true,
      info: `Handed over to ${toRepName}${crossBranch ? " (cross-branch)" : ""}`,
      lostAccess,
      toRepName,
    };
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

/// Grant or revoke one colleague's access across many leads: the ticked rows, or every lead
/// the current filters match (`query`, the leads table's own query string). Whichever it is,
/// the set is re-read here through the actor's own scope — never trusted from the browser.
export async function bulkLeadAccessAction(input: {
  action: "grant" | "revoke";
  leadIds?: string[];
  query?: string;
  scopeLabel: string;
  granteeUserId: string;
  reason?: string | null;
  durationDays?: number | null;
}): Promise<Result & { done?: number; skipped?: number }> {
  const user = await requireCapability("leads.grantAccess");
  const scope = { deletedAt: null, ...leadWhereForUser(user) };
  try {
    let where;
    if (input.leadIds) {
      where = { AND: [scope, { id: { in: input.leadIds } }] };
    } else {
      const raw: Record<string, string[]> = {};
      new URLSearchParams(input.query ?? "").forEach((v, k) => (raw[k] ??= []).push(v));
      where = leadListWhere(parseLeadListParams(raw), scope);
    }
    const leads = await prisma.lead.findMany({ where, select: { id: true } });
    const leadIds = leads.map((l) => l.id);
    if (leadIds.length === 0) return { ok: false, error: "No leads to change" };
    const actor = { id: user.id, email: user.email };
    if (input.action === "grant") {
      const res = await grantBulkLeadAccess({
        leadIds,
        granteeUserId: input.granteeUserId,
        reason: input.reason,
        durationDays: input.durationDays,
        scopeLabel: input.scopeLabel,
        actor,
      });
      revalidatePath("/leads");
      return { ok: true, done: res.granted, skipped: res.skipped };
    }
    const res = await revokeBulkLeadAccess({
      leadIds,
      granteeUserId: input.granteeUserId,
      scopeLabel: input.scopeLabel,
      actor,
    });
    revalidatePath("/leads");
    return { ok: true, done: res.revoked };
  } catch (err) {
    if (err instanceof OwnershipError) return { ok: false, error: err.message };
    logger.error(`bulkLeadAccessAction failed: ${String(err)}`);
    return { ok: false, error: "Could not change access" };
  }
}
