"use server";

// Server Actions for the appointments desk (§3.2). Read-only for now: slot search.
// Booking from this screen arrives with the front-desk calendar (Phase B).
import { requireCapability } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { schedulingEnabled, searchAvailability, type DayAvailability } from "@/lib/scheduling/booking";

export type SlotSearchResult =
  | { ok: true; requested: DayAvailability; next: DayAvailability | null }
  | { ok: false; error: string };

export async function searchSlots(params: {
  branchId: string;
  typeId: string;
  doctorId: string;
  dateKey: string;
}): Promise<SlotSearchResult> {
  await requireCapability("appointments.view");
  if (!(await schedulingEnabled())) return { ok: false, error: "The appointments module is switched off" };
  if (!params.branchId || !params.typeId) return { ok: false, error: "Pick a branch and a treatment" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.dateKey)) return { ok: false, error: "Pick a date" };
  try {
    return await searchAvailability({
      branchId: params.branchId,
      typeId: params.typeId,
      doctorId: params.doctorId || null,
      dateKey: params.dateKey,
    });
  } catch (err) {
    logger.error(`searchSlots failed: ${String(err)}`);
    return { ok: false, error: "Could not search for slots" };
  }
}
