"use server";

// Server Actions for the admin operating switches (§settings). Admin-only, and every
// change is written to the permanent audit log — these switches change what the system
// will and won't allow, so "who turned this off, and when" has to be answerable.
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import { setBoolSetting, ALLOW_UNINVOICED_CONVERSION } from "@/lib/settings";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string; info?: string };

export async function setAllowUninvoicedConversion(value: boolean): Promise<Result> {
  const user = await requireCapability("settings.manage");

  try {
    await setBoolSetting(ALLOW_UNINVOICED_CONVERSION, value, user.id ?? null);
    await writeAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: "settings.update",
      entityType: "setting",
      entityId: ALLOW_UNINVOICED_CONVERSION,
      field: "value",
      oldValue: String(!value),
      newValue: String(value),
      reason: value
        ? "Billing not connected — conversions accepted without an invoice"
        : "Billing connected — conversion now requires an invoice",
    });
    revalidatePath("/settings");
    return {
      ok: true,
      info: value
        ? "Counsellors can mark quotes converted without an invoice."
        : "Conversion now requires an invoice again.",
    };
  } catch (err) {
    logger.error(`setAllowUninvoicedConversion failed: ${String(err)}`);
    return { ok: false, error: "Could not save the setting" };
  }
}
