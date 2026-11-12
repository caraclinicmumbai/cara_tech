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
import {
  getPipeline,
  invalidatePipeline,
  quoteMoveTargets,
  slugify,
  stageMoveTargets,
  type PipelineKind,
} from "@/lib/pipeline";
import { LOST_STAGE, customStageKey, isLeadStage } from "@/lib/leadStages";
import { customQuoteStatusKey } from "@/lib/quoteStages";

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

// ── Pipeline: lead stages & quote statuses (lib/pipeline.ts) ─────────

const PIPELINE_LABEL_MAX = 60;
const kindName = (kind: PipelineKind) => (kind === "lead_stage" ? "stage" : "status");

function pipelineAudit(
  user: { id?: string | null; email?: string | null },
  action: string,
  kind: PipelineKind,
  key: string,
  oldValue: string | null,
  newValue: string | null,
  reason?: string,
) {
  return writeAudit({
    actorId: user.id, actorEmail: user.email, action, entityType: "setting",
    entityId: `${kind}:${key}`, field: "label", oldValue, newValue, reason,
  });
}

function revalidatePipeline() {
  revalidatePath("/settings");
  revalidatePath("/leads");
  revalidatePath("/quotes");
  revalidatePath("/chatbot");
}

/// Add a custom stage (placed after a built-in) or a custom quote status (open / closed).
export async function addPipelineStatus(input: {
  kind: PipelineKind;
  label: string;
  /// lead_stage: the built-in it follows. quote_status: "open" | "closed".
  placement: string;
}): Promise<Result> {
  const user = await requireCapability("settings.manage");
  const label = input.label.trim().slice(0, PIPELINE_LABEL_MAX);
  if (!label) return { ok: false, error: "Give it a name" };

  const p = await getPipeline();
  const existing = input.kind === "lead_stage" ? p.leadStages : p.quoteStatuses;
  if (existing.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
    return { ok: false, error: `There's already a ${kindName(input.kind)} called "${label}"` };
  }

  let base: string;
  if (input.kind === "lead_stage") {
    if (!isLeadStage(input.placement) || input.placement === LOST_STAGE) {
      return { ok: false, error: "Pick where the stage goes in the pipeline" };
    }
    base = customStageKey(input.placement, slugify(label));
  } else {
    if (input.placement !== "open" && input.placement !== "closed") {
      return { ok: false, error: "Pick whether the status is open or closed" };
    }
    base = customQuoteStatusKey(input.placement, slugify(label));
  }
  // A slug can repeat ("Follow-up" vs "Follow up"); a deleted key is never reused, so
  // old audit rows can't be mistaken for the new entry.
  let key = base;
  for (let n = 2; await prisma.pipelineStatus.findUnique({ where: { kind_key: { kind: input.kind, key } } }) ; n++) {
    key = `${base}_${n}`;
  }
  const used = input.kind === "lead_stage"
    ? await prisma.lead.count({ where: { stage: key } })
    : await prisma.quote.count({ where: { status: key } });
  if (used > 0) key = `${key}_${Date.now().toString(36)}`;

  try {
    await prisma.pipelineStatus.create({ data: { kind: input.kind, key, label, createdById: user.id ?? null } });
    invalidatePipeline();
    await pipelineAudit(user, "settings.pipeline.add", input.kind, key, null, label);
    revalidatePipeline();
    return { ok: true };
  } catch (err) {
    logger.error(`addPipelineStatus failed: ${String(err)}`);
    return { ok: false, error: `Could not add the ${kindName(input.kind)}` };
  }
}

/// Rename a built-in or custom entry. Stored keys don't change — only the name shown.
export async function renamePipelineStatus(input: { kind: PipelineKind; key: string; label: string }): Promise<Result> {
  const user = await requireCapability("settings.manage");
  const label = input.label.trim().slice(0, PIPELINE_LABEL_MAX);
  if (!label) return { ok: false, error: "The name can't be empty" };

  const p = await getPipeline();
  const list = input.kind === "lead_stage" ? p.leadStages : p.quoteStatuses;
  const entry = list.find((s) => s.key === input.key);
  if (!entry) return { ok: false, error: `That ${kindName(input.kind)} no longer exists` };
  if (entry.label === label) return { ok: true };
  if (list.some((s) => s.key !== input.key && s.label.toLowerCase() === label.toLowerCase())) {
    return { ok: false, error: `There's already a ${kindName(input.kind)} called "${label}"` };
  }

  try {
    await prisma.pipelineStatus.upsert({
      where: { kind_key: { kind: input.kind, key: input.key } },
      create: { kind: input.kind, key: input.key, label, createdById: user.id ?? null },
      update: { label },
    });
    invalidatePipeline();
    await pipelineAudit(user, "settings.pipeline.rename", input.kind, input.key, entry.label, label);
    revalidatePipeline();
    return { ok: true };
  } catch (err) {
    logger.error(`renamePipelineStatus failed: ${String(err)}`);
    return { ok: false, error: "Could not rename it" };
  }
}

/// Delete a CUSTOM entry. Leads (or quotes) in it move to `moveTo`, each move audited.
/// A stage a chatbot flow is triggered by can't be deleted until the flow is changed.
export async function deletePipelineStatus(input: { kind: PipelineKind; key: string; moveTo: string }): Promise<Result> {
  const user = await requireCapability("settings.manage");
  const p = await getPipeline();
  const isStage = input.kind === "lead_stage";
  const list = isStage ? p.leadStages : p.quoteStatuses;
  const entry = list.find((s) => s.key === input.key);
  if (!entry) return { ok: false, error: `That ${kindName(input.kind)} no longer exists` };
  if (entry.system) return { ok: false, error: "Built-in stages can be renamed but not deleted — the automation depends on them" };

  const targets = isStage ? stageMoveTargets(p, input.key) : quoteMoveTargets(p, input.key);
  const target = targets.find((t) => t.key === input.moveTo);

  try {
    if (isStage) {
      const flows = await prisma.chatbotFlow.findMany({
        where: { triggerEvent: "stage_change", triggerConfig: { path: ["stage"], equals: input.key } },
        select: { name: true },
      });
      if (flows.length) {
        return {
          ok: false,
          error: `Chatbot ${flows.length === 1 ? "flow" : "flows"} ${flows.map((f) => `"${f.name}"`).join(", ")} ${flows.length === 1 ? "starts" : "start"} when a lead enters "${entry.label}". Change ${flows.length === 1 ? "its" : "their"} trigger first.`,
        };
      }
      const leads = await prisma.lead.findMany({ where: { stage: input.key }, select: { id: true } });
      if (leads.length && !target) return { ok: false, error: "Pick the stage its leads move to" };
      const reason = `Stage "${entry.label}" deleted in Settings`;
      for (const l of leads) {
        await prisma.lead.update({
          where: { id: l.id },
          data: { stage: target!.key, stageChangedAt: new Date(), stageStuckNotifiedAt: null },
        });
        await writeAudit({
          actorId: user.id, actorEmail: user.email, action: "lead.stage.move", entityType: "lead",
          entityId: l.id, oldValue: input.key, newValue: target!.key, reason,
        });
      }
      await prisma.pipelineStatus.delete({ where: { kind_key: { kind: input.kind, key: input.key } } });
      invalidatePipeline();
      await pipelineAudit(user, "settings.pipeline.delete", input.kind, input.key, entry.label, null,
        leads.length ? `${leads.length} lead(s) moved to "${target!.label}"` : undefined);
      revalidatePipeline();
      return { ok: true, info: leads.length ? `${leads.length} lead${leads.length === 1 ? "" : "s"} moved to "${target!.label}".` : undefined };
    }

    const quotes = await prisma.quote.findMany({ where: { status: input.key }, select: { id: true, leadId: true } });
    if (quotes.length && !target) return { ok: false, error: "Pick the status its quotes move to" };
    const reason = `Status "${entry.label}" deleted in Settings`;
    for (const q of quotes) {
      await prisma.quote.update({ where: { id: q.id }, data: { status: target!.key } });
      await writeAudit({
        actorId: user.id, actorEmail: user.email, action: "lead.quote.status", entityType: "lead",
        entityId: q.leadId, oldValue: input.key, newValue: target!.key, reason, meta: { quoteId: q.id },
      });
    }
    await prisma.pipelineStatus.delete({ where: { kind_key: { kind: input.kind, key: input.key } } });
    invalidatePipeline();
    await pipelineAudit(user, "settings.pipeline.delete", input.kind, input.key, entry.label, null,
      quotes.length ? `${quotes.length} quote(s) moved to "${target!.label}"` : undefined);
    revalidatePipeline();
    return { ok: true, info: quotes.length ? `${quotes.length} quote${quotes.length === 1 ? "" : "s"} moved to "${target!.label}".` : undefined };
  } catch (err) {
    logger.error(`deletePipelineStatus failed: ${String(err)}`);
    return { ok: false, error: `Could not delete the ${kindName(input.kind)}` };
  }
}
