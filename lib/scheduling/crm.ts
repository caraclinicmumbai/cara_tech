// Appointments → CRM (spec §3, row 3.1). What an appointment tells the lead it belongs to.
//
//   • ATTENDED (completed) → the lead's stage moves to "Consultation done" — forward only,
//     so a patient already converted or further along isn't pulled back. Nothing else in
//     the CRM ever set that stage automatically; it sat at "Appointment scheduled" after
//     the patient had been and gone.
//   • NO-SHOW, or CANCELLED BY THE PATIENT → the stage stays (decision 3.b), and the owner
//     gets a follow-up due now: "missed — call to rebook". An appointment never marks a
//     lead Lost; that stays a person's call, with a reason.
//     Skipped when the patient already has another live booking (they rebooked), for an
//     online hold that lapsed (it was never a booking), and for clinic-side cancellations,
//     which the rebooking worklist (2.9) already owns.
//   • BOOKING links the appointment to the patient's quote for the same treatment, so
//     "which quote is this visit for" isn't a blank column.
//
// Best-effort throughout: a CRM hiccup must never undo or block the appointment change
// that caused it.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { advanceStage } from "@/lib/leadStages";
import { OPEN_QUOTE_STATUSES, WON_QUOTE_STATUSES } from "@/lib/quoteStages";
import { RESCHEDULABLE } from "@/lib/scheduling/status";
import type { Actor } from "@/lib/scheduling/booking";

/// Titles of the follow-ups an appointment raises — also how a repeat is recognised.
export const MISSED_TITLE = "Missed appointment — call to rebook";
export const CANCELLED_TITLE = "Patient cancelled — call to rebook";

export async function crmAfterStatus(input: {
  appointmentId: string;
  from: string;
  to: string;
  cancelledBy?: "patient" | "clinic" | null;
  actor: Actor;
}): Promise<void> {
  try {
    if (input.to === "completed") await attended(input.appointmentId, input.actor);
    else if (input.from !== "tentative" && (input.to === "no_show" || (input.to === "cancelled" && input.cancelledBy === "patient"))) {
      await missed(input.appointmentId, input.to === "no_show" ? MISSED_TITLE : CANCELLED_TITLE, input.actor);
    }
  } catch (err) {
    logger.error(`crmAfterStatus failed for appointment ${input.appointmentId}: ${String(err)}`);
  }
}

async function attended(appointmentId: string, actor: Actor): Promise<void> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { lead: { select: { id: true, stage: true, deletedAt: true } }, type: { select: { name: true } } },
  });
  if (!a || a.lead.deletedAt) return;
  const next = advanceStage(a.lead.stage, "consultation_done");
  if (!next) return;
  await prisma.lead.update({
    where: { id: a.lead.id },
    data: { stage: next, stageChangedAt: new Date(), stageStuckNotifiedAt: null },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "lead.stage.move",
    entityType: "lead",
    entityId: a.lead.id,
    field: "stage",
    oldValue: a.lead.stage,
    newValue: next,
    reason: `Attended: ${a.type.name}`,
    meta: { appointmentId, system: true },
  });
}

async function missed(appointmentId: string, title: string, actor: Actor): Promise<void> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      startAt: true,
      type: { select: { name: true } },
      lead: { select: { id: true, assignedRepId: true, deletedAt: true } },
    },
  });
  if (!a || a.lead.deletedAt) return;
  // Already rebooked? Then there's nothing to chase.
  const live = await prisma.appointment.count({
    where: { leadId: a.lead.id, id: { not: appointmentId }, status: { in: [...RESCHEDULABLE] }, startAt: { gte: new Date() } },
  });
  if (live > 0) return;
  // One chase per appointment, however many times the status is touched.
  const note = `appointment:${appointmentId}`;
  if (await prisma.leadFollowUpStep.findFirst({ where: { leadId: a.lead.id, note }, select: { id: true } })) return;

  const max = await prisma.leadFollowUpStep.aggregate({ where: { leadId: a.lead.id }, _max: { order: true } });
  await prisma.leadFollowUpStep.create({
    data: {
      leadId: a.lead.id,
      order: (max._max.order ?? -1) + 1,
      title,
      channel: "call",
      dueAt: new Date(),
      status: "pending",
      ownerKind: "rep",
      ownerRepId: a.lead.assignedRepId,
      source: "auto",
      note,
    },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "lead.followup.add",
    entityType: "lead",
    entityId: a.lead.id,
    newValue: title,
    reason: a.type.name,
    meta: { appointmentId, system: true },
  });
}

/// The patient's quote this booking is for: same treatment as the appointment type, still
/// open or won, newest first. Matched by catalogue item when both carry one, else by name
/// (the item's or the type's, case-insensitive) — free-text and older quotes have no item.
export async function matchingQuoteId(leadId: string, typeId: string): Promise<string | null> {
  const t = await prisma.appointmentType.findUnique({
    where: { id: typeId },
    select: { name: true, catalogItemId: true, catalogItem: { select: { name: true } } },
  });
  if (!t) return null;
  const names = [t.catalogItem?.name, t.name].filter((n): n is string => !!n);
  const q = await prisma.quote.findFirst({
    where: {
      leadId,
      status: { in: [...OPEN_QUOTE_STATUSES, ...WON_QUOTE_STATUSES] },
      OR: [
        // By catalogue item first-class; by name for free-text quotes and older ones.
        ...(t.catalogItemId ? [{ catalogItemId: t.catalogItemId }] : []),
        ...names.map((n) => ({ treatment: { equals: n, mode: "insensitive" as const } })),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return q?.id ?? null;
}
