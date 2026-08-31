"use server";

// Server Action for the lead's next follow-up date/time (§follow-up).
//
// The clinic asked for "just the dates, not the roadmap", and the roadmap panel that
// used to edit them went with it — which left the Follow up column readable and not
// settable. This is the narrow replacement: one date, on the step the column is
// already reading, audited like any other change to a lead.
import { revalidatePath } from "next/cache";
import { requireCapability, userCanAccessLead } from "@/lib/authz";
import { setNextFollowUp } from "@/lib/followups";
import { parseIstDateTimeLocal, formatIst } from "@/lib/datetime";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string; info?: string };

export async function setLeadFollowUp(input: {
  leadId: string;
  /// IST wall-clock, "YYYY-MM-DDTHH:mm" (what <input type="datetime-local"> gives),
  /// or empty to clear the date.
  dueAt: string;
  title?: string | null;
}): Promise<Result> {
  const user = await requireCapability("leads.edit");
  if (!(await userCanAccessLead(user, input.leadId))) return { ok: false, error: "Not found" };

  const raw = input.dueAt?.trim() ?? "";
  // Read the wall-clock as IST rather than as the browser's timezone: "3:30 pm" means
  // half past three at the clinic, whatever the counsellor's laptop is set to.
  const dueAt = raw ? parseIstDateTimeLocal(raw) : null;
  if (raw && !dueAt) return { ok: false, error: "That isn't a valid date and time" };

  try {
    const { stepId, previous, created } = await setNextFollowUp({
      leadId: input.leadId,
      dueAt,
      title: input.title ?? null,
    });

    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: "lead.followup.due",
      entityType: "lead",
      entityId: input.leadId,
      field: "dueAt",
      oldValue: previous ? previous.toISOString() : null,
      newValue: dueAt ? dueAt.toISOString() : null,
      meta: { stepId, created },
    });

    revalidatePath(`/leads/${input.leadId}`);
    revalidatePath("/leads");
    return {
      ok: true,
      info: dueAt ? `Follow up set for ${formatIst(dueAt)}` : "Follow-up date cleared",
    };
  } catch (err) {
    logger.error(`setLeadFollowUp failed for ${input.leadId}: ${String(err)}`);
    return { ok: false, error: "Could not save the follow-up date" };
  }
}
