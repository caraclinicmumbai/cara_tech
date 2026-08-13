// Audit trail (§compliance / handover). A thin wrapper over the AuditLog table so
// tracked changes are recorded uniformly and can be read back per-lead or globally
// (the /audit screen). Best-effort: a failed audit write logs but never blocks the
// action that triggered it.
//
// Action-name convention (dot-namespaced): lead.field.update | lead.stage.move |
// lead.consent.change | lead.assign | lead.handover | lead.access.grant |
// lead.access.revoke | lead.merge | lead.softDelete | lead.restore |
// lead.permanentDelete | lead.export | role.permissions.change | …
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

export type AuditInput = {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string; // lead | quote | role | export | auth | setting | …
  entityId?: string | null;
  field?: string | null; // which field changed (for lead.field.update)
  oldValue?: string | null;
  newValue?: string | null;
  reason?: string | null;
  ip?: string | null; // request IP (record views, logins)
  userAgent?: string | null; // device string (stored in meta.userAgent)
  meta?: Record<string, unknown> | null;
};

// ── Tamper-evidence (hash chain) ─────────────────────────────────────────────
// Each row stores hash = sha256(canonical(row) + prevHash-of-previous-row). If any
// prior row is altered or removed, every subsequent hash stops matching and
// verifyAuditChain() flags it. Writes are serialised with a Postgres advisory lock so
// the chain is strictly linear. Append-only-ness is ALSO enforced at the DB by a trigger
// that forbids UPDATE/DELETE (scripts/protectAuditLog.ts) — together: the app cannot edit
// a log, and out-of-band tampering is detectable.
const AUDIT_LOCK_KEY = 748_923_155;

/// Order-independent stringify (sorted keys) so a jsonb round-trip hashes identically.
function stable(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}

type ChainFields = {
  at: string; actorId: string | null; actorEmail: string | null; action: string;
  entityType: string; entityId: string | null; field: string | null; oldValue: string | null;
  newValue: string | null; reason: string | null; ip: string | null;
  meta: unknown; prevHash: string | null;
};

function auditHash(r: ChainFields): string {
  const canon = stable([
    r.at, r.actorId, r.actorEmail, r.action, r.entityType, r.entityId, r.field,
    r.oldValue, r.newValue, r.reason, r.ip, r.meta, r.prevHash,
  ]);
  return createHash("sha256").update(canon).digest("hex");
}

/// Write one audit row into the tamper-evident chain. Never throws — audit must not
/// break the primary action.
export async function writeAudit(input: AuditInput): Promise<void> {
  const meta = input.userAgent ? { ...(input.meta ?? {}), userAgent: input.userAgent } : (input.meta ?? null);
  try {
    await prisma.$transaction(async (tx) => {
      // Serialise audit inserts so prevHash always points at the true previous row.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);
      // Stamp `at` INSIDE the lock so it is monotonic with insertion order — otherwise a
      // row inserted later could carry an earlier timestamp and break the verify ordering.
      const at = new Date();
      const last = await tx.auditLog.findFirst({
        orderBy: [{ at: "desc" }, { id: "desc" }],
        select: { hash: true },
      });
      const prevHash = last?.hash ?? null;
      const hash = auditHash({
        at: at.toISOString(),
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        field: input.field ?? null,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        meta,
        prevHash,
      });
      await tx.auditLog.create({
        data: {
          at,
          actorId: input.actorId ?? null,
          actorEmail: input.actorEmail ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          field: input.field ?? null,
          oldValue: input.oldValue ?? null,
          newValue: input.newValue ?? null,
          reason: input.reason ?? null,
          ip: input.ip ?? null,
          meta: (meta ?? undefined) as object | undefined,
          prevHash,
          hash,
        },
      });
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
  ip: string | null;
  meta: Record<string, unknown> | null;
};

function toEntry(r: {
  id: string; at: Date; action: string; actorEmail: string | null; entityType: string;
  entityId: string | null; field: string | null; oldValue: string | null; newValue: string | null;
  reason: string | null; ip: string | null; meta: Prisma.JsonValue | null;
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
    ip: r.ip,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
  };
}

const ENTRY_SELECT = {
  id: true, at: true, action: true, actorEmail: true, entityType: true, entityId: true,
  field: true, oldValue: true, newValue: true, reason: true, ip: true, meta: true,
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
    "lead.quote.create": "Quote created",
    "lead.quote.status": "Quote status",
    "lead.quote.owner": "Quote owner",
    "lead.quote.revise": "Quote price revised",
    "lead.followup.add": "Follow-up step added",
    "lead.followup.done": "Follow-up step done",
    "lead.followup.skip": "Follow-up step skipped",
    "lead.followup.reopen": "Follow-up step reopened",
    "lead.followup.reassign": "Follow-up owner changed",
    "lead.followup.delete": "Follow-up step removed",
    "lead.comment.add": "Comment added",
    "lead.comment.delete": "Comment deleted",
    "lead.softDelete": "Moved to trash",
    "lead.restore": "Restored",
    "lead.permanentDelete": "Permanently deleted",
    "lead.export": "Data export",
    "role.permissions.change": "Role permissions changed",
    "role.permissions.reset": "Role permissions reset",
    "presence.change": "Status changed",
    "presence.auto": "Status auto-changed",
  };
  return map[action] ?? action;
}

// ── Integrity verification ───────────────────────────────────────────────────
export type ChainResult = {
  ok: boolean;
  checked: number;
  brokenAt?: { id: string; at: string; action: string; reason: string };
};

/// Walk the hash chain (only rows written with a hash — i.e. everything since chaining
/// was enabled) and confirm nothing has been altered or removed. On the first mismatch,
/// returns where it broke. O(n) over the audited history.
export async function verifyAuditChain(limit = 50_000): Promise<ChainResult> {
  const rows = await prisma.auditLog.findMany({
    where: { hash: { not: null } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true, at: true, actorId: true, actorEmail: true, action: true, entityType: true,
      entityId: true, field: true, oldValue: true, newValue: true, reason: true, ip: true,
      meta: true, prevHash: true, hash: true,
    },
  });
  let prev: string | null = null;
  let checked = 0;
  for (const r of rows) {
    if ((r.prevHash ?? null) !== prev) {
      return { ok: false, checked, brokenAt: { id: r.id, at: r.at.toISOString(), action: r.action, reason: "Broken link — a previous entry was altered or removed" } };
    }
    const expected = auditHash({
      at: r.at.toISOString(), actorId: r.actorId, actorEmail: r.actorEmail, action: r.action,
      entityType: r.entityType, entityId: r.entityId, field: r.field, oldValue: r.oldValue,
      newValue: r.newValue, reason: r.reason, ip: r.ip, meta: r.meta, prevHash: r.prevHash ?? null,
    });
    if (expected !== r.hash) {
      return { ok: false, checked, brokenAt: { id: r.id, at: r.at.toISOString(), action: r.action, reason: "Content mismatch — this entry was altered" } };
    }
    prev = r.hash;
    checked++;
  }
  return { ok: true, checked };
}
