"use server";

// Server Actions for the post-sales ERP (§post-sales). Every function re-checks the
// caller's capability, because Server Functions are reachable by direct POST — the UI
// hiding a button is not a control.
//
// The capability split IS the spec: `postsales.manage` moves clinical stages and is
// deliberately NOT granted to sales counsellors ("The Post-Sales team owns these
// stages. Sales counsellors can't edit them."), while `postsales.checkins` covers the
// care-message workflow that the front desk also does.
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  moveJourneyStage,
  setSurgeryDate,
  assignJourneyStaff,
  regenerateHandover,
  JourneyError,
  type AssignmentRole,
} from "@/lib/postSales/journeys";
import { resolveCheckIn, rescheduleCheckIn } from "@/lib/postSales/checkins";
import { isJourneyStage } from "@/lib/postSales/stages";
import { builtInPolicy, parseCheckInDays, parseStageDays } from "@/lib/postSales/policy";

type Result = { ok: boolean; error?: string };

const REASON_MAX = 500;
const NOTE_MAX = 4000;

/// Refresh both the board and the journey page after a mutation.
function revalidateJourney(journeyId: string): void {
  revalidatePath("/post-sales");
  revalidatePath(`/post-sales/${journeyId}`);
}

/// Turn a domain error into a user-facing message, and anything else into a generic
/// one (a stack trace is not for the patient-facing screen).
function toError(err: unknown, fallback: string, context: string): Result {
  if (err instanceof JourneyError) return { ok: false, error: err.message };
  if (err instanceof Error && err.message && err.message.length < 200) {
    logger.error(`${context}: ${err.message}`);
    return { ok: false, error: err.message };
  }
  logger.error(`${context}: ${String(err)}`);
  return { ok: false, error: fallback };
}

/// Parse a datetime-local string ("2026-08-18T14:30") as IST wall-clock. The clinic
/// types local time; the server runs UTC, so an unqualified parse would land 5h30m out.
function parseIstDateTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0"] = m;
  // IST is UTC+5:30 year-round (no DST), so the shift is a constant.
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) - 5.5 * 60 * 60 * 1000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Journey stages + assignment (postsales.manage) ───────────────────

/// Move a journey to another clinical stage. A backward move needs a written reason;
/// entering Surgery Done needs the surgery date.
export async function moveStage(input: {
  journeyId: string;
  stage: string;
  reason?: string | null;
  surgeryAt?: string | null;
  closedNote?: string | null;
}): Promise<Result> {
  const user = await requireCapability("postsales.manage");
  if (!isJourneyStage(input.stage)) return { ok: false, error: "Unknown stage" };

  try {
    await moveJourneyStage({
      journeyId: input.journeyId,
      to: input.stage,
      reason: input.reason?.slice(0, REASON_MAX) ?? null,
      surgeryAt: parseIstDateTime(input.surgeryAt),
      closedNote: input.closedNote?.slice(0, REASON_MAX) ?? null,
      actor: { id: user.id, email: user.email },
    });
  } catch (err) {
    return toError(err, "Could not move the journey", `moveStage ${input.journeyId}`);
  }
  revalidateJourney(input.journeyId);
  return { ok: true };
}

/// Correct the recorded surgery date — re-anchors every un-sent check-in.
export async function updateSurgeryDate(input: { journeyId: string; surgeryAt: string }): Promise<Result> {
  const user = await requireCapability("postsales.manage");
  const at = parseIstDateTime(input.surgeryAt);
  if (!at) return { ok: false, error: "Enter a valid surgery date" };

  try {
    await setSurgeryDate({ journeyId: input.journeyId, surgeryAt: at, actor: { id: user.id, email: user.email } });
  } catch (err) {
    return toError(err, "Could not set the surgery date", `updateSurgeryDate ${input.journeyId}`);
  }
  revalidateJourney(input.journeyId);
  return { ok: true };
}

/// Assign (or clear) the doctor / OT lead / consultant on a journey.
export async function assignStaff(input: {
  journeyId: string;
  role: string;
  userId: string | null;
}): Promise<Result> {
  const user = await requireCapability("postsales.manage");
  if (!["doctor", "otLead", "consultant"].includes(input.role)) {
    return { ok: false, error: "Unknown post-sales role" };
  }

  try {
    await assignJourneyStaff({
      journeyId: input.journeyId,
      role: input.role as AssignmentRole,
      userId: input.userId || null,
      actor: { id: user.id, email: user.email },
    });
  } catch (err) {
    return toError(err, "Could not assign that person", `assignStaff ${input.journeyId}`);
  }
  revalidateJourney(input.journeyId);
  return { ok: true };
}

/// Regenerate the handover snapshot (sales corrected the patient's details after
/// handover). The live parts of the summary are always current; this refreshes the
/// permanent snapshot.
export async function refreshHandover(input: { journeyId: string }): Promise<Result> {
  const user = await requireCapability("postsales.manage");
  try {
    await regenerateHandover(input.journeyId, { id: user.id, email: user.email });
  } catch (err) {
    return toError(err, "Could not regenerate the handover summary", `refreshHandover ${input.journeyId}`);
  }
  revalidateJourney(input.journeyId);
  return { ok: true };
}

// ── Care check-ins (postsales.checkins) ──────────────────────────────

/// Close out a check-in by hand — how a `blocked` one gets resolved (the consultant
/// phoned instead of messaging) and how an unwanted one is skipped.
export async function resolveCheckInAction(input: {
  journeyId: string;
  checkInId: string;
  status: string;
  note?: string | null;
}): Promise<Result> {
  const user = await requireCapability("postsales.checkins");
  if (input.status !== "done_manually" && input.status !== "skipped") {
    return { ok: false, error: "A check-in can only be marked done or skipped" };
  }
  // Skipping a scheduled clinical contact should say why — it's a care decision.
  if (input.status === "skipped" && !input.note?.trim()) {
    return { ok: false, error: "Say why this check-in is being skipped" };
  }

  try {
    await resolveCheckIn({
      checkInId: input.checkInId,
      status: input.status,
      note: input.note?.slice(0, REASON_MAX) ?? null,
      actor: { id: user.id, email: user.email },
    });
  } catch (err) {
    return toError(err, "Could not update the check-in", `resolveCheckIn ${input.checkInId}`);
  }
  revalidateJourney(input.journeyId);
  return { ok: true };
}

/// Re-date a check-in (the patient asked to be contacted later). Clears any automation
/// block so the engine will try again at the new time.
export async function rescheduleCheckInAction(input: {
  journeyId: string;
  checkInId: string;
  scheduledFor: string;
}): Promise<Result> {
  const user = await requireCapability("postsales.checkins");
  const at = parseIstDateTime(input.scheduledFor);
  if (!at) return { ok: false, error: "Enter a valid date and time" };

  try {
    await rescheduleCheckIn({ checkInId: input.checkInId, scheduledFor: at, actor: { id: user.id, email: user.email } });
  } catch (err) {
    return toError(err, "Could not reschedule the check-in", `rescheduleCheckIn ${input.checkInId}`);
  }
  revalidateJourney(input.journeyId);
  return { ok: true };
}

// ── Journey notes (postsales.view is not enough — writing needs manage/checkins) ──

/// Add a clinical or admin note to a journey. Journey-scoped, so a note about the
/// transplant doesn't surface on the same patient's PRP journey.
export async function addJourneyNote(input: {
  journeyId: string;
  body: string;
  kind?: string | null;
}): Promise<Result> {
  const user = await requireCapability("postsales.checkins");
  const body = input.body?.trim().slice(0, NOTE_MAX);
  if (!body) return { ok: false, error: "The note is empty" };
  const kind = input.kind === "admin" ? "admin" : "clinical";

  const journey = await prisma.postSalesJourney.findUnique({
    where: { id: input.journeyId },
    select: { id: true, quoteId: true },
  });
  if (!journey) return { ok: false, error: "Journey not found" };

  await prisma.postSalesNote.create({
    data: {
      journeyId: journey.id,
      authorId: user.id ?? null,
      authorName: user.name ?? user.email ?? null,
      kind,
      body,
    },
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "postsales.note.add",
    entityType: "quote",
    entityId: journey.quoteId,
    field: kind,
    meta: { journeyId: journey.id },
  });
  revalidateJourney(input.journeyId);
  return { ok: true };
}

/// Delete a journey note. The author may delete their own; `postsales.manage` may
/// delete anyone's (mirrors how LeadComment deletion works for managers).
export async function deleteJourneyNote(input: { journeyId: string; noteId: string }): Promise<Result> {
  const user = await requireCapability("postsales.checkins");
  const note = await prisma.postSalesNote.findUnique({
    where: { id: input.noteId },
    select: { id: true, authorId: true, journeyId: true, journey: { select: { quoteId: true } } },
  });
  if (!note || note.journeyId !== input.journeyId) return { ok: false, error: "Note not found" };

  const isAuthor = !!user.id && note.authorId === user.id;
  if (!isAuthor) {
    // Not theirs — needs the stage-owning capability to remove someone else's note.
    try {
      await requireCapability("postsales.manage");
    } catch {
      return { ok: false, error: "You can only delete your own notes" };
    }
  }

  await prisma.postSalesNote.delete({ where: { id: note.id } });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "postsales.note.delete",
    entityType: "quote",
    entityId: note.journey.quoteId,
    meta: { journeyId: input.journeyId, noteId: note.id, ownNote: isAuthor },
  });
  revalidateJourney(input.journeyId);
  return { ok: true };
}

// ── Per-treatment stage limits (postsales.policy) ────────────────────

/// Create or update a treatment's stage time limits + check-in schedule. Values are
/// narrowed server-side (positive whole days, known stage keys only) because the
/// columns are JSON and a bad value would silently disable a clock.
export async function saveTreatmentPolicy(input: {
  treatmentType: string;
  label?: string | null;
  stageDays: Record<string, string | number>;
  checkInDays: string;
  active?: boolean;
  isDefault?: boolean;
}): Promise<Result> {
  const user = await requireCapability("postsales.policy");
  const key = input.treatmentType?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (!key) return { ok: false, error: "A treatment key is required" };

  const stageDays = parseStageDays(input.stageDays);
  if (Object.keys(stageDays).length === 0) {
    return { ok: false, error: "Set at least one stage limit (whole days, greater than zero)" };
  }
  const checkInDays = parseCheckInDays(
    (input.checkInDays ?? "").split(/[,\s]+/).filter(Boolean),
  );
  if (checkInDays.length === 0) {
    return { ok: false, error: "Set at least one check-in day (e.g. 1, 7, 30, 90)" };
  }

  const label = input.label?.trim().slice(0, 120) || builtInPolicy(key).label;
  const before = await prisma.treatmentStagePolicy.findUnique({ where: { treatmentType: key } });

  await prisma.$transaction(async (tx) => {
    // Exactly one default: promoting this one demotes the rest, so getPolicy()'s
    // fallback can never be ambiguous.
    if (input.isDefault) {
      await tx.treatmentStagePolicy.updateMany({
        where: { isDefault: true, treatmentType: { not: key } },
        data: { isDefault: false },
      });
    }
    await tx.treatmentStagePolicy.upsert({
      where: { treatmentType: key },
      create: {
        treatmentType: key,
        label,
        stageDays,
        checkInDays,
        active: input.active ?? true,
        isDefault: input.isDefault ?? false,
        updatedById: user.id ?? null,
      },
      update: {
        label,
        stageDays,
        checkInDays,
        active: input.active ?? true,
        isDefault: input.isDefault ?? false,
        updatedById: user.id ?? null,
      },
    });
  });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "postsales.policy.save",
    entityType: "setting",
    entityId: key,
    field: "stageDays",
    oldValue: before ? JSON.stringify(before.stageDays) : null,
    newValue: JSON.stringify(stageDays),
    meta: { treatmentType: key, checkInDays, active: input.active ?? true, isDefault: input.isDefault ?? false },
  });
  logger.info(`Post-sales policy "${key}" saved by ${user.email ?? "?"}`);
  revalidatePath("/post-sales/policies");
  revalidatePath("/post-sales");
  return { ok: true };
}
