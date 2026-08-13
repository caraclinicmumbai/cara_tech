// Per-lead follow-up roadmap (§follow-up roadmap). A lead carries an ordered list
// of follow-up steps — the "sales roadmap" — each with its own status and an
// accountable actor (a telecaller/counsellor rep, the sales head, or the AI).
//
// Steps are SEEDED from a standard template at intake and are hand-editable
// thereafter (add / complete / skip / reassign). Only pending | done | skipped
// are persisted; "missed" is DERIVED at read time (a pending step past its due
// date), so no background sweep is needed to turn a step red.
import { prisma } from "@/lib/prisma";
import { getSalesHead } from "@/lib/salesReps";
import { logger } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowUpChannel = "ai_call" | "call" | "whatsapp" | "quote" | "custom";
export type FollowUpOwnerKind = "ai" | "rep" | "sales_head";
/// The visual state a step renders as. `missed` is derived, never stored.
export type FollowUpVisualStatus = "done" | "missed" | "todo" | "skipped";

type TemplateStep = {
  title: string;
  channel: FollowUpChannel;
  dayOffset: number; // days after lead creation the step is due
  ownerKind: FollowUpOwnerKind;
};

/// The default follow-up roadmap seeded on every actively-pursued new lead. Owners
/// resolve at seed time: `rep` → the lead's assigned counsellor, `sales_head` →
/// the sales head, `ai` → the automated caller. Staff can edit any of it after.
export const FOLLOWUP_TEMPLATE: TemplateStep[] = [
  { title: "AI first call", channel: "ai_call", dayOffset: 0, ownerKind: "ai" },
  { title: "AI reconfirmation call", channel: "ai_call", dayOffset: 1, ownerKind: "ai" },
  { title: "Counsellor follow-up call", channel: "call", dayOffset: 3, ownerKind: "rep" },
  { title: "WhatsApp follow-up", channel: "whatsapp", dayOffset: 5, ownerKind: "rep" },
  { title: "Counsellor callback", channel: "call", dayOffset: 7, ownerKind: "rep" },
  { title: "Sales-head review", channel: "custom", dayOffset: 14, ownerKind: "sales_head" },
];

/// Seed the standard roadmap onto a lead. Idempotent — a no-op if the lead already
/// has any steps. Best-effort by design (never throws into the intake flow).
export async function seedFollowUpSteps(input: {
  leadId: string;
  ownerRepId: string | null;
  startAt: Date;
}): Promise<number> {
  const existing = await prisma.leadFollowUpStep.count({ where: { leadId: input.leadId } });
  if (existing > 0) return 0;

  // Resolve the sales head once (may be null if none configured).
  const salesHead = await getSalesHead();

  const rows = FOLLOWUP_TEMPLATE.map((t, i) => {
    const ownerRepId =
      t.ownerKind === "rep" ? input.ownerRepId : t.ownerKind === "sales_head" ? (salesHead?.id ?? null) : null;
    return {
      leadId: input.leadId,
      order: i,
      title: t.title,
      channel: t.channel,
      dueAt: new Date(input.startAt.getTime() + t.dayOffset * DAY_MS),
      ownerKind: t.ownerKind,
      ownerRepId,
      source: "template",
    };
  });

  await prisma.leadFollowUpStep.createMany({ data: rows });
  return rows.length;
}

export type FollowUpStepView = {
  id: string;
  order: number;
  title: string;
  channel: string;
  dueAt: string | null; // ISO
  status: string; // stored: pending | done | skipped
  visual: FollowUpVisualStatus; // derived (adds "missed")
  completedAt: string | null; // ISO
  ownerKind: string;
  ownerRepId: string | null;
  ownerName: string; // resolved label: rep name, "AI", or "Unassigned"
  source: string;
  note: string | null;
};

/// The visual status a step renders as: done/skipped are stored outright; a
/// pending step with a past due date is `missed` (red); everything else is `todo`.
export function visualStatus(
  step: { status: string; dueAt: Date | null },
  now: number = Date.now(),
): FollowUpVisualStatus {
  if (step.status === "done") return "done";
  if (step.status === "skipped") return "skipped";
  if (step.dueAt && step.dueAt.getTime() < now) return "missed";
  return "todo";
}

/// The accountable actor's display label for a step.
function ownerLabel(step: { ownerKind: string; ownerRep: { name: string } | null }): string {
  if (step.ownerKind === "ai") return "AI";
  return step.ownerRep?.name ?? "Unassigned";
}

/// The lead's follow-up roadmap, ordered, with owners resolved + visual status.
export async function listFollowUpSteps(
  leadId: string,
  now: number = Date.now(),
): Promise<FollowUpStepView[]> {
  const steps = await prisma.leadFollowUpStep.findMany({
    where: { leadId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: { ownerRep: { select: { name: true } } },
  });
  return steps.map((s) => ({
    id: s.id,
    order: s.order,
    title: s.title,
    channel: s.channel,
    dueAt: s.dueAt ? s.dueAt.toISOString() : null,
    status: s.status,
    visual: visualStatus(s, now),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    ownerKind: s.ownerKind,
    ownerRepId: s.ownerRepId,
    ownerName: ownerLabel(s),
    source: s.source,
    note: s.note,
  }));
}

/// A compact roll-up for the section header, e.g. "2 done · 1 missed · 3 to do".
export function summariseRoadmap(steps: FollowUpStepView[]): string {
  if (steps.length === 0) return "No follow-up steps yet";
  const done = steps.filter((s) => s.visual === "done").length;
  const missed = steps.filter((s) => s.visual === "missed").length;
  const todo = steps.filter((s) => s.visual === "todo").length;
  const skipped = steps.filter((s) => s.visual === "skipped").length;
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (missed) parts.push(`${missed} missed`);
  if (todo) parts.push(`${todo} to do`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(" · ");
}

// Best-effort seed helper for intake — logs and swallows failures so a roadmap
// hiccup never blocks lead creation.
export async function seedFollowUpStepsSafe(input: {
  leadId: string;
  ownerRepId: string | null;
  startAt: Date;
}): Promise<void> {
  try {
    const n = await seedFollowUpSteps(input);
    if (n) logger.info(`Seeded ${n} follow-up steps for lead ${input.leadId}`);
  } catch (err) {
    logger.error(`Follow-up seed failed for lead ${input.leadId}: ${String(err)}`);
  }
}
