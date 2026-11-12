// The clinic's own lead stages and quote statuses (Settings → Pipeline).
//
// The built-ins live in code (lib/leadStages.ts, lib/quoteStages.ts) because the
// automation depends on them by key: calls move leads into "appointment_scheduled",
// "lost" asks for a reason, "converted" locks a quote and opens post-sales. So a
// built-in can be RENAMED here but never removed. A custom entry can be added, renamed
// and deleted; deleting one moves its leads / quotes to a stage the admin picks.
//
// PipelineStatus rows hold the renames and the custom entries. Every screen reads names
// through getPipeline(); a short in-process cache keeps that off the hot path, cleared
// on every write (the worker picks a change up within the TTL).
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  LEAD_STAGES,
  STAGE_LABELS,
  LOST_STAGE,
  customStageAnchor,
  stageLabel as fallbackStageLabel,
  type LeadStage,
} from "@/lib/leadStages";
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  OPEN_QUOTE_STATUSES,
  WON_QUOTE_STATUSES,
  customQuoteCategory,
  isQuoteStatus,
  type QuoteStatus,
} from "@/lib/quoteStages";

export type PipelineKind = "lead_stage" | "quote_status";

export type StageOption = {
  key: string;
  label: string;
  /// Built-in: renamable, not deletable (automation depends on it).
  system: boolean;
  /// Custom stages: the built-in it sits after.
  after?: LeadStage;
  /// Built-ins: what the system does with it, shown in Settings.
  note?: string;
};

export type QuoteStatusOption = {
  key: string;
  label: string;
  system: boolean;
  category: "open" | "won" | "closed";
  note?: string;
};

export type Pipeline = {
  /// In pipeline order: each custom stage right after its built-in.
  leadStages: StageOption[];
  /// Open statuses, then won, then closed; customs after the built-ins of their kind.
  quoteStatuses: QuoteStatusOption[];
  stageLabel: (key: string) => string;
  quoteStatusLabel: (key: string) => string;
};

/// What each built-in drives, so an admin sees why it can't be deleted.
const STAGE_NOTES: Partial<Record<LeadStage, string>> = {
  ai_contacted: "Every new lead starts here",
  ai_attempted_unreachable: "Set by the AI calls when a lead can't be reached",
  communication_not_established: "Set when a call is rescheduled",
  human_callback_pending: "Set when the AI hands a lead to a person",
  appointment_scheduled: "Set when a consultation is booked",
  consultation_done: "Set when a consultation is completed",
  lost: "Asks for a reason; ends the pipeline",
};

const QUOTE_NOTES: Partial<Record<QuoteStatus, string>> = {
  drafted: "Every new quote starts here",
  accepted: "Moves the quote to Awaiting Payment",
  converted: "Needs an invoice; locks the quote and starts post-sales",
  in_treatment: "Set by the post-sales journey",
  completed: "Set by the post-sales journey",
  rejected: "Asks for a reason from the list",
  expired: "Set when a quote passes its validity date",
  replaced: "Set when a revised quote replaces this one",
  withdrawn: "Asks for a reason",
};

function quoteCategory(s: QuoteStatus): QuoteStatusOption["category"] {
  if ((OPEN_QUOTE_STATUSES as string[]).includes(s)) return "open";
  if ((WON_QUOTE_STATUSES as string[]).includes(s)) return "won";
  return "closed";
}

const TTL_MS = 30_000;
let cache: { at: number; value: Pipeline } | null = null;

export function invalidatePipeline(): void {
  cache = null;
}

export async function getPipeline(): Promise<Pipeline> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  let rows: { kind: string; key: string; label: string; createdAt: Date }[] = [];
  try {
    rows = await prisma.pipelineStatus.findMany({
      orderBy: { createdAt: "asc" },
      select: { kind: true, key: true, label: true, createdAt: true },
    });
  } catch (err) {
    // Names must never take a page down: fall back to the built-in defaults.
    logger.error(`Could not read pipeline names, using defaults: ${String(err)}`);
  }
  const named = (kind: PipelineKind) => new Map(rows.filter((r) => r.kind === kind).map((r) => [r.key, r.label]));
  const stageNames = named("lead_stage");
  const quoteNames = named("quote_status");

  const customStages = rows.filter((r) => r.kind === "lead_stage" && customStageAnchor(r.key));
  const leadStages: StageOption[] = [];
  for (const s of LEAD_STAGES) {
    leadStages.push({ key: s, label: stageNames.get(s) ?? STAGE_LABELS[s], system: true, note: STAGE_NOTES[s] });
    for (const c of customStages) {
      if (customStageAnchor(c.key) === s) leadStages.push({ key: c.key, label: c.label, system: false, after: s });
    }
  }

  const customStatuses = rows.filter((r) => r.kind === "quote_status" && customQuoteCategory(r.key));
  const builtIn = (QUOTE_STATUSES as readonly QuoteStatus[]).map((s) => ({
    key: s,
    label: quoteNames.get(s) ?? QUOTE_STATUS_LABELS[s],
    system: true,
    category: quoteCategory(s),
    note: QUOTE_NOTES[s],
  }));
  const custom = (cat: "open" | "closed") =>
    customStatuses
      .filter((r) => customQuoteCategory(r.key) === cat)
      .map((r) => ({ key: r.key, label: r.label, system: false, category: cat }));
  const quoteStatuses: QuoteStatusOption[] = [
    ...builtIn.filter((s) => s.category === "open"),
    ...custom("open"),
    ...builtIn.filter((s) => s.category === "won"),
    ...builtIn.filter((s) => s.category === "closed"),
    ...custom("closed"),
  ];

  const stageMap = new Map(leadStages.map((s) => [s.key, s.label]));
  const quoteMap = new Map(quoteStatuses.map((s) => [s.key, s.label]));
  const value: Pipeline = {
    leadStages,
    quoteStatuses,
    // A key no longer in the pipeline (a deleted custom stage on an old audit row) still
    // reads as something sensible.
    stageLabel: (k) => stageMap.get(k) ?? fallbackStageLabel(k),
    quoteStatusLabel: (k) => quoteMap.get(k) ?? (isQuoteStatus(k) ? QUOTE_STATUS_LABELS[k] : k),
  };
  cache = { at: Date.now(), value };
  return value;
}

/// Is `key` a lead stage a lead may be put in right now (built-in, or a custom one
/// that still exists)?
export async function isActiveStage(key: string): Promise<boolean> {
  return (await getPipeline()).leadStages.some((s) => s.key === key);
}

export async function isActiveQuoteStatus(key: string): Promise<boolean> {
  return (await getPipeline()).quoteStatuses.some((s) => s.key === key);
}

/// "Second opinion" → "second_opinion" (unique within its kind, max 40 chars).
export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "stage"
  );
}

/// Lead stages a deleted custom stage's leads may move to: anything else but Lost
/// (which needs a reason per lead).
export function stageMoveTargets(p: Pipeline, deleting: string): StageOption[] {
  return p.leadStages.filter((s) => s.key !== deleting && s.key !== LOST_STAGE);
}

/// Quote statuses a deleted custom status's quotes may move to: the same kind (open →
/// open, closed → closed), minus the ones that need a per-quote reason or mean
/// something specific (rejected, withdrawn, replaced, accepted).
export function quoteMoveTargets(p: Pipeline, deleting: string): QuoteStatusOption[] {
  const cat = customQuoteCategory(deleting);
  return p.quoteStatuses.filter(
    (s) =>
      s.key !== deleting &&
      s.category === cat &&
      !["rejected", "withdrawn", "replaced", "accepted"].includes(s.key),
  );
}
