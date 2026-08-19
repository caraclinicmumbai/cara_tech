// Post-sales stage SLA (§post-sales: "Time limits per stage, per treatment type.
// Hair transplant recovery is not PRP recovery. Overdue = alert.").
//
// Each journey carries `stageDueAt`, armed on every stage move from the treatment's
// TreatmentStagePolicy. This sweep finds the journeys that have blown through it and
// tells the person accountable — the consultant first (they own the patient
// relationship), then the doctor, then the post-sales channel. `overdueNotifiedAt`
// dedups so one stall produces one alert, and it is cleared on every stage move so the
// NEXT stall alerts afresh.
//
// Deliberately a DB-polling sweep like the stage/presence sweeps rather than a delayed
// job per journey: the policy can change under a journey in flight, and polling
// re-evaluates against the live number instead of a stale one baked into a queued job.
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { JOURNEY_STAGE_LABELS, TERMINAL_JOURNEY_STAGE, type JourneyStage } from "@/lib/postSales/stages";

/// Where post-sales alerts go. Its own channel by default so clinical stalls don't get
/// lost in the sales feed; falls back to the counsellor/default channel.
export function postSalesChannel(): string | undefined {
  return (
    process.env.POSTSALES_CHANNEL ??
    process.env.COUNSELLOR_CHANNEL ??
    process.env.SLACK_DEFAULT_CHANNEL
  );
}

const SCAN_BATCH = 200;

export type PostSalesSlaStats = { scanned: number; alerted: number; skipped: number };

function daysOver(dueAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / (24 * 60 * 60 * 1000)));
}

/// One pass: alert on every live journey past its stage limit that hasn't been alerted
/// for this stall yet. Never throws — one bad row can't stall the sweep.
export async function runPostSalesSlaScan(now: Date = new Date()): Promise<PostSalesSlaStats> {
  const stats: PostSalesSlaStats = { scanned: 0, alerted: 0, skipped: 0 };

  const overdue = await prisma.postSalesJourney.findMany({
    where: {
      stage: { not: TERMINAL_JOURNEY_STAGE },
      stageDueAt: { lt: now },
      overdueNotifiedAt: null,
    },
    orderBy: { stageDueAt: "asc" },
    take: SCAN_BATCH,
    select: {
      id: true,
      quoteId: true,
      stage: true,
      stageDueAt: true,
      stageChangedAt: true,
      treatmentType: true,
      quote: { select: { treatment: true } },
      lead: { select: { id: true, name: true, phone: true, deletedAt: true } },
      branch: { select: { name: true } },
      consultant: { select: { name: true, email: true } },
      doctor: { select: { name: true, email: true } },
    },
  });

  for (const j of overdue) {
    stats.scanned++;
    try {
      // A deleted patient record isn't a clinical stall worth waking anyone for.
      if (j.lead.deletedAt) {
        await prisma.postSalesJourney.update({
          where: { id: j.id },
          data: { overdueNotifiedAt: now },
        });
        stats.skipped++;
        continue;
      }

      const stageLabel = JOURNEY_STAGE_LABELS[j.stage as JourneyStage] ?? j.stage;
      const over = j.stageDueAt ? daysOver(j.stageDueAt, now) : 0;
      const owner = j.consultant?.name ?? j.doctor?.name ?? "nobody assigned";

      await writeAudit({
        action: "postsales.stage.overdue",
        entityType: "quote",
        entityId: j.quoteId,
        field: "journeyStage",
        oldValue: j.stage,
        newValue: `overdue by ${over}d`,
        meta: {
          journeyId: j.id,
          leadId: j.lead.id,
          treatment: j.quote.treatment,
          treatmentType: j.treatmentType,
          stageDueAt: j.stageDueAt?.toISOString() ?? null,
          consultant: j.consultant?.email ?? null,
          doctor: j.doctor?.email ?? null,
        },
      });

      const channel = postSalesChannel();
      if (isSlackConfigured() && channel) {
        const base = process.env.NEXTAUTH_URL;
        const link = base ? `\n<${base}/post-sales/${j.id}|Open journey>` : "";
        const branch = j.branch?.name ? ` · ${j.branch.name}` : "";
        const text =
          `⏰ *Post-sales overdue* — ${j.lead.name}${branch}\n` +
          `*${j.quote.treatment}* has been in *${stageLabel}* ${over > 0 ? `${over} day${over === 1 ? "" : "s"} past` : "past"} its limit.\n` +
          `*Accountable:* ${owner}${link}`;
        await sendSlack({ text, channel }).catch((err) =>
          logger.error(`Post-sales SLA Slack alert failed for journey ${j.id}: ${String(err)}`),
        );
      }

      await prisma.postSalesJourney.update({
        where: { id: j.id },
        data: { overdueNotifiedAt: now },
      });
      stats.alerted++;
      logger.info(`Post-sales journey ${j.id} overdue in ${j.stage} (${over}d past) — alerted ${owner}`);
    } catch (err) {
      logger.error(`Post-sales SLA check failed for journey ${j.id}: ${String(err)}`);
    }
  }

  if (stats.scanned > 0) logger.info(`Post-sales SLA scan: ${JSON.stringify(stats)}`);
  return stats;
}

/// A safety net for the handover itself (§"this is the single most likely bug in the
/// whole change"): a quote that converted but never got a journey. Opens the missing
/// journeys and reports how many — so a crash between the conversion commit and the
/// journey insert can't leave a paying patient outside the post-sales pipeline.
export async function reconcileMissingJourneys(): Promise<number> {
  const { openJourneyForQuote } = await import("@/lib/postSales/journeys");
  const orphans = await prisma.quote.findMany({
    where: {
      status: { in: ["converted", "in_treatment", "completed"] },
      journey: null,
      lead: { deletedAt: null },
    },
    select: { id: true },
    take: SCAN_BATCH,
  });
  let opened = 0;
  for (const q of orphans) {
    try {
      if (await openJourneyForQuote(q.id)) opened++;
    } catch (err) {
      logger.error(`Reconcile: could not open journey for quote ${q.id}: ${String(err)}`);
    }
  }
  if (opened > 0) {
    logger.warn(`Reconcile: opened ${opened} missing post-sales journey(ies) for converted quotes`);
  }
  return opened;
}
