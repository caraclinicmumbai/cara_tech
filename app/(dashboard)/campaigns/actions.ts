"use server";

// Stop a lead's running follow-up campaign from the UI (§follow-up). Gated to
// `campaigns.manage`; the stop is attributed to the actor in the audit log. Used by the
// per-lead campaign card and the /campaigns overview.
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import { stopEnrollmentForLead } from "@/lib/campaigns/engine";

export type StopResult = { ok: boolean; stopped: number };

export async function stopLeadCampaign(leadId: string): Promise<StopResult> {
  const actor = await requireCapability("campaigns.manage");
  // A manual stop uses a reason distinct from "replied", so it does NOT reactivate a Lost
  // lead (that re-entry is reserved for a genuine inbound reply, not a staff stop).
  const stopped = await stopEnrollmentForLead(leadId, "stopped_by_staff", { id: actor.id, email: actor.email });
  revalidatePath("/campaigns");
  revalidatePath(`/leads/${leadId}`);
  return { ok: stopped > 0, stopped };
}
