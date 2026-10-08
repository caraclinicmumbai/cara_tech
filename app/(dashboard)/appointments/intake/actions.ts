"use server";

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/authz";
import { setFieldVerified } from "@/lib/scheduling/intake/service";

/// A clinician confirms one patient-reported answer (§2.7).
export async function verifyIntakeField(responseId: string, field: string, verified: boolean) {
  const user = await requireCapability("appointments.verifyIntake");
  const r = await setFieldVerified(responseId, field, verified, user);
  revalidatePath(`/appointments/intake/${responseId}`);
  return r;
}
