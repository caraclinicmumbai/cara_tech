// Audit trail (§compliance / handover). A thin wrapper over the AuditLog table so
// tracked changes are recorded uniformly and can be read back per-lead or globally
// (the /audit screen). Best-effort: a failed audit write logs but never blocks the
// action that triggered it.
//
// Action-name convention (dot-namespaced): lead.field.update | lead.stage.move |
// lead.consent.change | lead.assign | lead.handover | lead.access.grant |
// lead.access.revoke | lead.merge | lead.softDelete | lead.restore |
// lead.permanentDelete | lead.export | role.permissions.change | …
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

export type AuditInput = {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string; // lead | quote | role | export | …
  entityId?: string | null;
  field?: string | null; // which field changed (for lead.field.update)
  oldValue?: string | null;
  newValue?: string | null;
  reason?: string | null;
  meta?: Record<string, unknown> | null;
};

/// Write one audit row. Never throws — audit must not break the primary action.
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        field: input.field ?? null,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
        reason: input.reason ?? null,
        meta: (input.meta ?? undefined) as object | undefined,
      },
    });
  } catch (err) {
    logger.error(`writeAudit failed (${input.action} on ${input.entityType}:${input.entityId}): ${String(err)}`);
  }
}

type Actor = { id?: string | null; email?: string | null };

/// Record a single lead field change (old → new). No-op when the value is unchanged.
export async function auditLeadFieldUpdate(
  actor: Actor,
  leadId: string,
  field: string,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
  reason?: string | null,
): Promise<void> {
  const o = oldValue ?? "";
  const n = newValue ?? "";
  if (o === n) return;
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "lead.field.update",
    entityType: "lead",
    entityId: leadId,
    field,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    reason: reason ?? null,
  });
}

/// Diff a set of tracked fields on a lead and write one row per change.
export async function auditLeadFieldChanges(
  actor: Actor,
  leadId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
  reason?: string | null,
): Promise<void> {
  for (const f of fields) {
    const o = before[f];
    const n = after[f];
    const os = o == null ? null : String(o);
    const ns = n == null ? null : String(n);
    if ((os ?? "") !== (ns ?? "")) await auditLeadFieldUpdate(actor, leadId, f, os, ns, reason);
  }
}

export type AuditEntry = {
  id: string;
  at: string; // ISO
  action: string;
  actorEmail: string | null;
  entityType: string;
  entityId: string | null;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  meta: Record<string, unknown> | null;
};

function toEntry(r: {
  id: string; at: Date; action: string; actorEmail: string | null; entityType: string;
  entityId: string | null; field: string | null; oldValue: string | null; newValue: string | null;
  reason: string | null; meta: Prisma.JsonValue | null;
}): AuditEntry {
  return {
    id: r.id,
    at: r.at.toISOString(),
    action: r.action,
    actorEmail: r.actorEmail,
    entityType: r.entityType,
    entityId: r.entityId,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  };
}

const ENTRY_SELECT = {
  id: true, at: true, action: true, actorEmail: true, entityType: true, entityId: true,
  field: true, oldValue: true, newValue: true, reason: true, meta: true,
} satisfies Prisma.AuditLogSelect;

/// All audit events for one lead (newest first) — optionally restricted to a set of
/// action names (e.g. the ownership panel passes only handover/access actions).
export async function readLeadAudit(leadId: string, actions?: string[]): Promise<AuditEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: "lead",
      entityId: leadId,
      ...(actions?.length ? { action: { in: actions } } : { action: { startsWith: "lead." } }),
    },
    orderBy: { at: "desc" },
    take: 200,
    select: ENTRY_SELECT,
  });
  return rows.map(toEntry);
}

// Back-compat alias used by the ownership panel (handover/access history).
export const OWNERSHIP_ACTIONS = ["lead.handover", "lead.access.grant", "lead.access.revoke"];
export function readLeadTimeline(leadId: string): Promise<AuditEntry[]> {
  return readLeadAudit(leadId, OWNERSHIP_ACTIONS);
}

export type AuditFilters = {
  action?: string; // exact action, or a prefix ending in "." (e.g. "lead.")
  entityType?: string;
  entityId?: string;
  actorEmail?: string;
  from?: Date;
  to?: Date;
  take?: number;
};

/// Global audit reader for the /audit screen. Applies optional filters, newest first.
export async function listAuditLog(filters: AuditFilters = {}): Promise<AuditEntry[]> {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.action) {
    where.action = filters.action.endsWith(".") ? { startsWith: filters.action } : filters.action;
  }
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.actorEmail) where.actorEmail = { contains: filters.actorEmail, mode: "insensitive" };
  if (filters.from || filters.to) {
    where.at = {};
    if (filters.from) where.at.gte = filters.from;
    if (filters.to) where.at.lte = filters.to;
  }
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { at: "desc" },
    take: Math.min(filters.take ?? 200, 500),
    select: ENTRY_SELECT,
  });
  return rows.map(toEntry);
}

/// A short human label for an action (for the timeline / audit table).
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    "lead.field.update": "Field changed",
    "lead.stage.move": "Stage moved",
    "lead.consent.change": "Consent changed",
    "lead.assign": "Assigned",
    "lead.handover": "Handover",
    "lead.access.grant": "Access granted",
    "lead.access.revoke": "Access revoked",
    "lead.merge": "Merged duplicate",
    "lead.softDelete": "Moved to trash",
    "lead.restore": "Restored",
    "lead.permanentDelete": "Permanently deleted",
    "lead.export": "Data export",
    "role.permissions.change": "Role permissions changed",
    "role.permissions.reset": "Role permissions reset",
  };
  return map[action] ?? action;
}
