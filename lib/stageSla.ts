// Stuck-in-stage SLA scan (§3.1). A lead that hasn't advanced its pipeline stage
// within STAGE_SLA_DAYS (default 7) has lost momentum — the counsellor is alerted
// so it can be unblocked. Run periodically by the worker.
//
// Dedup is stateful, not column-comparing: a lead is alerted only while
// `stageStuckNotifiedAt` is null. We stamp it after alerting; every stage change
// resets it to null (see callIntake / setLeadStage), so the next stall re-alerts
// exactly once.
import { prisma } from "@/lib/prisma";
import { notifyCounsellor } from "@/lib/counsellor";
import { stageLabel, STAGE_SLA_EXCLUDED } from "@/lib/leadStages";
import { logger } from "@/lib/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/// Days a lead may sit in one stage before it's flagged stuck. Default 7.
export function stageSlaDays(): number {
  const d = Number(process.env.STAGE_SLA_DAYS ?? 7);
  return Number.isFinite(d) && d > 0 ? d : 7;
}

/// Scan for leads stuck past the SLA and alert the counsellor for each (once per
/// stall). Returns how many were alerted. Best-effort; never throws.
export async function runStageSlaScan(limit = 200): Promise<number> {
  const days = stageSlaDays();
  const cutoff = new Date(Date.now() - days * DAY_MS);

  try {
    const stuck = await prisma.lead.findMany({
      where: {
        stage: { notIn: STAGE_SLA_EXCLUDED },
        stageChangedAt: { lt: cutoff },
        stageStuckNotifiedAt: null, // not yet alerted for this stall
        optedOut: false, // don't chase opted-out leads
      },
      select: { id: true, name: true, phone: true, stage: true, stageChangedAt: true },
      orderBy: { stageChangedAt: "asc" },
      take: limit,
    });
    if (stuck.length === 0) return 0;

    for (const lead of stuck) {
      const daysStuck = lead.stageChangedAt
        ? Math.floor((Date.now() - lead.stageChangedAt.getTime()) / DAY_MS)
        : days;
      await notifyCounsellor({
        kind: "stage_sla",
        lead,
        reason: `No movement in *${stageLabel(lead.stage)}* for ${daysStuck} days (SLA ${days}d).`,
      });
      // Stamp so we don't re-alert until the stage changes (which nulls this).
      await prisma.lead.update({
        where: { id: lead.id },
        data: { stageStuckNotifiedAt: new Date() },
      });
    }
    logger.info(`Stage-SLA scan alerted ${stuck.length} stuck lead(s) (>${days}d)`);
    return stuck.length;
  } catch (err) {
    logger.error(`Stage-SLA scan failed: ${String(err)}`);
    return 0;
  }
}
