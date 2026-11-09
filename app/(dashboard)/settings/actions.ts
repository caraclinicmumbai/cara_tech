"use server";

// Server Actions for the admin operating switches (§settings). Admin-only, and every
// change is written to the permanent audit log — these switches change what the system
// will and won't allow, so "who turned this off, and when" has to be answerable.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { setBoolSetting, ALLOW_UNINVOICED_CONVERSION } from "@/lib/settings";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { isRole } from "@/lib/rbac";
import { STAGE_TONES, stageRoleLabel } from "@/lib/scheduling/stages";

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

// ── Appointment stages (#7) ──────────────────────────────────────────────────
// The steps of a consultation or treatment visit, per appointment type. Admin-only, like
// the switches above, because the clinic sets these with Dr. Asif.

export type StageInput = { label: string; role: string; tone: string };

function normaliseStage(input: StageInput) {
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!label) return { ok: false as const, error: "Give the stage a name" };
  if (!isRole(input.role)) return { ok: false as const, error: "Pick the role that does this stage" };
  const tone = (STAGE_TONES as readonly string[]).includes(input.tone) ? input.tone : "ink";
  return { ok: true as const, data: { label, role: input.role, tone } };
}

async function stageAudit(user: { id?: string; email?: string | null }, action: string, stageId: string, newValue: string) {
  await writeAudit({ actorId: user.id, actorEmail: user.email, action, entityType: "appointment_stage", entityId: stageId, newValue });
}

export async function createStage(typeId: string, input: StageInput): Promise<Result> {
  const user = await requireCapability("settings.manage");
  const n = normaliseStage(input);
  if (!n.ok) return n;
  try {
    const max = await prisma.appointmentStage.aggregate({ where: { typeId }, _max: { order: true } });
    const row = await prisma.appointmentStage.create({
      data: { typeId, ...n.data, order: (max._max.order ?? 0) + 1 },
      select: { id: true, type: { select: { name: true } } },
    });
    await stageAudit(user, "settings.stage.create", row.id, `${row.type.name}: ${n.data.label} (${stageRoleLabel(n.data.role)})`);
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error(`createStage failed: ${String(err)}`);
    return { ok: false, error: "Could not add the stage" };
  }
}

export async function updateStage(id: string, input: StageInput): Promise<Result> {
  const user = await requireCapability("settings.manage");
  const n = normaliseStage(input);
  if (!n.ok) return n;
  try {
    await prisma.appointmentStage.update({ where: { id }, data: n.data });
    await stageAudit(user, "settings.stage.update", id, `${n.data.label} (${stageRoleLabel(n.data.role)})`);
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error(`updateStage failed: ${String(err)}`);
    return { ok: false, error: "Could not save the stage" };
  }
}

/// Swap a stage with its neighbour above (-1) or below (+1) within its appointment type.
export async function moveStage(id: string, dir: -1 | 1): Promise<Result> {
  const user = await requireCapability("settings.manage");
  try {
    const s = await prisma.appointmentStage.findUnique({ where: { id }, select: { typeId: true } });
    if (!s) return { ok: false, error: "Stage not found" };
    const list = await prisma.appointmentStage.findMany({ where: { typeId: s.typeId }, orderBy: [{ order: "asc" }, { createdAt: "asc" }], select: { id: true, label: true } });
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return { ok: true };
    [list[i], list[j]] = [list[j], list[i]];
    await prisma.$transaction(list.map((x, k) => prisma.appointmentStage.update({ where: { id: x.id }, data: { order: k + 1 } })));
    await stageAudit(user, "settings.stage.reorder", id, list.map((x) => x.label).join(" → "));
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error(`moveStage failed: ${String(err)}`);
    return { ok: false, error: "Could not move the stage" };
  }
}

/// Remove a stage. One that no appointment has ticked yet is deleted outright; one that
/// has been used is retired, so past visits keep the record of who did it.
export async function removeStage(id: string): Promise<Result> {
  const user = await requireCapability("settings.manage");
  try {
    const s = await prisma.appointmentStage.findUnique({ where: { id }, select: { label: true, _count: { select: { done: true } } } });
    if (!s) return { ok: false, error: "Stage not found" };
    if (s._count.done > 0) {
      await prisma.appointmentStage.update({ where: { id }, data: { active: false } });
      await stageAudit(user, "settings.stage.retire", id, s.label);
      revalidatePath("/settings");
      return { ok: true, info: `"${s.label}" was already used on visits, so it's retired rather than deleted.` };
    }
    await prisma.appointmentStage.delete({ where: { id } });
    await stageAudit(user, "settings.stage.delete", id, s.label);
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error(`removeStage failed: ${String(err)}`);
    return { ok: false, error: "Could not remove the stage" };
  }
}

export async function restoreStage(id: string): Promise<Result> {
  const user = await requireCapability("settings.manage");
  try {
    const s = await prisma.appointmentStage.update({ where: { id }, data: { active: true }, select: { label: true } });
    await stageAudit(user, "settings.stage.restore", id, s.label);
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    logger.error(`restoreStage failed: ${String(err)}`);
    return { ok: false, error: "Could not restore the stage" };
  }
}
