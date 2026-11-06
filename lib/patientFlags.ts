// Pin or unpin a flag on a patient (§3.2 "Cards and Flags for a Patient"). One audited
// write shared by the two places staff do it: the lead page and the appointment card.
// Callers check who may do it; the vocabulary lives in lib/scheduling/flags.ts.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export async function applyPatientFlag(input: {
  leadId: string;
  flagId: string;
  on: boolean;
  actor: { id?: string; email?: string | null };
}): Promise<{ ok: boolean; error?: string }> {
  const { leadId, flagId, on, actor } = input;
  const flag = await prisma.flagDefinition.findUnique({ where: { id: flagId }, select: { label: true } });
  if (!flag) return { ok: false, error: "Unknown flag" };
  if (on) {
    await prisma.leadFlag.upsert({
      where: { leadId_flagId: { leadId, flagId } },
      create: { leadId, flagId, setById: actor.id ?? null },
      update: {},
    });
  } else {
    await prisma.leadFlag.deleteMany({ where: { leadId, flagId } });
  }
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: on ? "lead.flag.set" : "lead.flag.clear",
    entityType: "lead",
    entityId: leadId,
    field: "flag",
    newValue: flag.label,
  });
  return { ok: true };
}
