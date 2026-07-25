// Audit trail helper (§handover / compliance). A thin wrapper over the AuditLog table
// so ownership/access events (and later, other tracked changes) are recorded uniformly
// and can be read back as a per-lead timeline. Best-effort: a failed audit write logs
// but never blocks the action that triggered it.
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export type AuditInput = {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string; // e.g. lead.handover | lead.access.grant | lead.access.revoke
  entityType: string; // lead | quote | role | …
  entityId?: string | null;
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

export type TimelineEntry = {
  id: string;
  at: string; // ISO
  action: string;
  actorEmail: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  meta: Record<string, unknown> | null;
};

/// Read a lead's ownership/access history (handovers + grants/revokes), newest first.
export async function readLeadTimeline(leadId: string): Promise<TimelineEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: "lead", entityId: leadId, action: { startsWith: "lead." } },
    orderBy: { at: "desc" },
    take: 100,
    select: { id: true, at: true, action: true, actorEmail: true, oldValue: true, newValue: true, reason: true, meta: true },
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    action: r.action,
    actorEmail: r.actorEmail,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  }));
}
