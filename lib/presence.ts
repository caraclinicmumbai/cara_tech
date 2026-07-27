// Counsellor presence engine (§presence "Knowing who's available"). One place that
// owns the availability state machine, the activity heartbeat, the auto
// In-Consultation on a live call, and the 15-minute idle auto-offline sweep.
//
// Availability is DISTINCT from SalesRep.active (the admin employment flag). The
// four states and their routing effect:
//   available       — in the round-robin, gets new leads normally
//   in_consultation — skipped; new leads → next available; hot leads also ping the manager
//   break           — skipped; new leads → next available
//   offline         — skipped; leads route to a colleague with the SAME speciality
//
// Best-effort throughout: presence must never break a call flow or a request, so the
// auto/sweep helpers log and swallow their own errors.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { counsellorChannel } from "@/lib/counsellor";
import { isWithinDnd } from "@/lib/callWindow";
import { logger } from "@/lib/logger";
import { availabilityLabel, type Availability } from "@/lib/presenceStatus";

// Minutes of no heartbeat (during working hours) before a counsellor is auto-set
// Offline and their manager is told. "Working hours" = outside the DND window.
export const IDLE_MINUTES = Number(process.env.PRESENCE_IDLE_MINUTES ?? 15);

/// Set a counsellor's availability and record the transition (audited). Manual
/// changes carry the acting user; automatic ones pass `auto` (call_start | call_end
/// | idle). Leaving In-Consultation always clears the on-call flag.
export async function setAvailability(
  repId: string,
  value: Availability,
  opts: { actorId?: string | null; actorEmail?: string | null; auto?: string } = {},
): Promise<void> {
  const before = await prisma.salesRep.findUnique({
    where: { id: repId },
    select: { availability: true, name: true },
  });
  if (!before) return;

  const now = new Date();
  // A no-op re-tap still counts as activity (they're clearly at the keyboard).
  if (before.availability === value) {
    await prisma.salesRep.update({ where: { id: repId }, data: { lastActivityAt: now } });
    return;
  }

  await prisma.salesRep.update({
    where: { id: repId },
    data: {
      availability: value,
      availabilityAt: now,
      lastActivityAt: now,
      ...(value !== "in_consultation" ? { onCall: false } : {}),
    },
  });

  await writeAudit({
    action: opts.auto ? "presence.auto" : "presence.change",
    entityType: "rep",
    entityId: repId,
    actorId: opts.actorId ?? null,
    actorEmail: opts.actorEmail ?? null,
    oldValue: availabilityLabel(before.availability),
    newValue: availabilityLabel(value),
    ...(opts.auto ? { meta: { auto: opts.auto } } : {}),
  });
  logger.info(`Presence: ${before.name} → ${value}${opts.auto ? ` (auto: ${opts.auto})` : ""}`);
}

/// Heartbeat: record that the counsellor is active right now. Cheap, unaudited,
/// swallows its own errors — called on a timer from the header status switcher.
export async function recordActivity(repId: string): Promise<void> {
  await prisma.salesRep
    .update({ where: { id: repId }, data: { lastActivityAt: new Date() } })
    .catch(() => {});
}

/// Auto-detect: a click-to-call just started for this rep — mark In-Consultation
/// "without asking" and flag onCall so the call-end webhook can revert it. Does not
/// clobber someone who was already In-Consultation. (§presence auto-detect)
export async function beginConsultation(repId: string): Promise<void> {
  try {
    const rep = await prisma.salesRep.findUnique({ where: { id: repId }, select: { availability: true } });
    if (!rep) return;
    const changing = rep.availability !== "in_consultation";
    await prisma.salesRep.update({
      where: { id: repId },
      data: {
        onCall: true,
        lastActivityAt: new Date(),
        ...(changing ? { availability: "in_consultation", availabilityAt: new Date() } : {}),
      },
    });
    if (changing) {
      await writeAudit({
        action: "presence.auto",
        entityType: "rep",
        entityId: repId,
        oldValue: availabilityLabel(rep.availability),
        newValue: availabilityLabel("in_consultation"),
        meta: { auto: "call_start" },
      });
    }
  } catch (err) {
    logger.error(`beginConsultation failed for rep ${repId}: ${String(err)}`);
  }
}

/// The call we auto-started has ended — revert to Active, but only if WE set the
/// In-Consultation (onCall). If they manually moved to Break/Offline mid-call we
/// leave that alone. (§presence auto-detect)
export async function endConsultation(repId: string): Promise<void> {
  try {
    const rep = await prisma.salesRep.findUnique({
      where: { id: repId },
      select: { availability: true, onCall: true },
    });
    if (!rep || !rep.onCall) return;
    const reverting = rep.availability === "in_consultation";
    await prisma.salesRep.update({
      where: { id: repId },
      data: {
        onCall: false,
        ...(reverting ? { availability: "available", availabilityAt: new Date() } : {}),
      },
    });
    if (reverting) {
      await writeAudit({
        action: "presence.auto",
        entityType: "rep",
        entityId: repId,
        oldValue: availabilityLabel("in_consultation"),
        newValue: availabilityLabel("available"),
        meta: { auto: "call_end" },
      });
    }
  } catch (err) {
    logger.error(`endConsultation failed for rep ${repId}: ${String(err)}`);
  }
}

/// Where a rep's oversight alert goes: their branch manager's Slack DM if we can
/// resolve it (the manager login → linked rep → slackUserId), else the counsellor
/// channel. (§presence "tell the manager")
export async function managerSlackTarget(rep: { branchId: string | null }): Promise<string | undefined> {
  if (rep.branchId) {
    const branch = await prisma.branch.findUnique({
      where: { id: rep.branchId },
      select: { manager: { select: { salesRep: { select: { slackUserId: true } } } } },
    });
    const sid = branch?.manager?.salesRep?.slackUserId;
    if (sid) return sid;
  }
  return counsellorChannel();
}

/// Auto-offline sweep (§presence): during working hours, any active rep who hasn't
/// sent a heartbeat in IDLE_MINUTES and isn't on a call is set Offline and their
/// manager is told. Run on a short timer by the worker. Idempotent per pass —
/// already-offline reps are excluded, so it won't re-alert.
export async function sweepIdle(): Promise<{ swept: number }> {
  // "during working hours" — skip the do-not-call night window entirely.
  if (isWithinDnd()) return { swept: 0 };

  const cutoff = new Date(Date.now() - IDLE_MINUTES * 60_000);
  const stale = await prisma.salesRep.findMany({
    where: {
      active: true,
      onCall: false,
      availability: { not: "offline" },
      lastActivityAt: { lt: cutoff },
    },
    select: { id: true, name: true, branchId: true },
  });

  for (const rep of stale) {
    await setAvailability(rep.id, "offline", { auto: "idle" });
    if (isSlackConfigured()) {
      const target = await managerSlackTarget(rep);
      if (target) {
        await sendSlack({
          channel: target,
          text:
            `😴 *${rep.name}* was set to *Offline* automatically — no activity for ${IDLE_MINUTES} min ` +
            `during working hours. Their new leads will route to another available counsellor.`,
        }).catch(() => {});
      }
    }
  }

  if (stale.length) {
    logger.info(`Presence sweep: ${stale.length} rep(s) auto-offline (idle > ${IDLE_MINUTES}m)`);
  }
  return { swept: stale.length };
}
