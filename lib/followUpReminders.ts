// Follow-up reminders (§follow-up reminders).
//
// A date on a lead is a promise to call somebody back. Until now the CRM stored that
// promise and showed it in a column, but nothing ever told the counsellor the moment
// arrived — they had to remember to go and look, which is exactly what the date was
// supposed to replace.
//
// The sweep finds steps that have come due and tells the person accountable for them:
//   • the in-app bell FIRST, because it works with nothing configured and reaches the
//     person wherever they are in the app;
//   • Slack as well when it's wired up, but never instead — Slack being down or
//     unconfigured must not mean a silent reminder.
//
// One reminder per due date, tracked by `remindedAt`. Moving a step's `dueAt` clears it
// (see setNextFollowUp), so a rescheduled follow-up reminds again at its new time.
import { prisma } from "@/lib/prisma";
import { notifyRep, notifyUser } from "@/lib/notifications";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { formatIst } from "@/lib/datetime";
import { logger } from "@/lib/logger";

/// How late a step may be and still earn a reminder. Past this it's not a reminder,
/// it's an archaeology report — the overdue marker in the table covers those, and
/// firing a burst of week-old bells after a worker outage helps nobody.
const MAX_LATE_MS = 24 * 60 * 60_000;

/// Safety valve on one pass, so a backlog can't flood the bell.
const BATCH = 100;

export type ReminderResult = { due: number; notified: number; skipped: number };

/// Fire reminders for every follow-up that has come due. Never throws — the worker
/// calls it on a timer and a bad row must not stop the next sweep.
export async function runFollowUpReminders(now: Date = new Date()): Promise<ReminderResult> {
  const result: ReminderResult = { due: 0, notified: 0, skipped: 0 };

  let steps: {
    id: string;
    title: string;
    dueAt: Date | null;
    ownerKind: string;
    ownerRepId: string | null;
    leadId: string;
    lead: {
      name: string;
      phone: string;
      deletedAt: Date | null;
      assignedRepId: string | null;
      stage: string;
    };
  }[];

  try {
    steps = await prisma.leadFollowUpStep.findMany({
      where: {
        status: "pending",
        remindedAt: null,
        dueAt: { lte: now, gt: new Date(now.getTime() - MAX_LATE_MS) },
        // A trashed lead's promises don't need keeping.
        lead: { deletedAt: null },
      },
      orderBy: { dueAt: "asc" },
      take: BATCH,
      select: {
        id: true,
        title: true,
        dueAt: true,
        ownerKind: true,
        ownerRepId: true,
        leadId: true,
        lead: {
          select: { name: true, phone: true, deletedAt: true, assignedRepId: true, stage: true },
        },
      },
    });
  } catch (err) {
    logger.error(`Follow-up reminder sweep could not read due steps: ${String(err)}`);
    return result;
  }

  result.due = steps.length;

  for (const step of steps) {
    try {
      // Steps the AI owns aren't a person's to be reminded of — the calling engine
      // drives those. A lead that's already closed is nobody's follow-up either.
      if (step.ownerKind === "ai" || step.lead.stage === "lost") {
        await markReminded(step.id, now);
        result.skipped += 1;
        continue;
      }

      // Accountable = the step's own owner, falling back to the lead's counsellor. A
      // step with neither has nobody to tell, so it's marked and left alone rather
      // than re-read on every sweep forever.
      const repId = step.ownerRepId ?? step.lead.assignedRepId;
      if (!repId) {
        logger.warn(`Follow-up ${step.id} is due but has no owner — no reminder sent`);
        await markReminded(step.id, now);
        result.skipped += 1;
        continue;
      }

      const when = step.dueAt ? formatIst(step.dueAt) : "now";
      const title = `⏰ Follow-up due — ${step.lead.name}`;
      const body = `${step.title} · was due ${when}`;

      const delivered = await notifyRep(repId, {
        kind: "followup_due",
        title,
        body,
        leadId: step.leadId,
        // One bell per step per due date, even if the sweep somehow runs twice.
        dedupeKey: `followup:${step.id}:${step.dueAt?.getTime() ?? 0}`,
      });

      await notifySlack(step, repId, when);

      // Marked whatever the bell said: a rep with no linked login can't be notified,
      // and retrying that every minute would be a loop, not a reminder.
      await markReminded(step.id, now);
      if (delivered) result.notified += 1;
      else result.skipped += 1;
    } catch (err) {
      logger.error(`Follow-up reminder failed for step ${step.id}: ${String(err)}`);
    }
  }

  if (result.due > 0) {
    logger.info(
      `Follow-up reminders: ${result.due} due, ${result.notified} notified, ${result.skipped} skipped`,
    );
  }
  return result;
}

async function markReminded(stepId: string, at: Date): Promise<void> {
  await prisma.leadFollowUpStep.update({ where: { id: stepId }, data: { remindedAt: at } });
}

/// Slack, when it's configured — an addition to the bell, never a replacement. DMs the
/// counsellor where we know their Slack id, otherwise falls back to the shared channel.
async function notifySlack(
  step: { title: string; leadId: string; lead: { name: string; phone: string } },
  repId: string,
  when: string,
): Promise<void> {
  if (!isSlackConfigured()) return;
  try {
    const rep = await prisma.salesRep.findUnique({
      where: { id: repId },
      select: { name: true, slackUserId: true },
    });
    const base = process.env.NEXTAUTH_URL;
    const link = base ? ` <${base}/leads/${step.leadId}|Open lead>` : "";
    const who = rep?.slackUserId ? `<@${rep.slackUserId}>` : (rep?.name ?? "counsellor");
    await sendSlack({
      text: `⏰ *Follow-up due* — ${step.lead.name} (${step.lead.phone})\n${step.title} · due ${when} · ${who}${link}`,
      // A DM when we can address them, the shared channel otherwise.
      channel: rep?.slackUserId ?? undefined,
    });
  } catch (err) {
    // Slack is the optional half. Log and move on — the bell already fired.
    logger.error(`Follow-up reminder Slack send failed for lead ${step.leadId}: ${String(err)}`);
  }
}

/// Notify a specific USER (not a rep) — used where a login owns the follow-up directly.
/// Exported for completeness; the sweep routes through reps.
export async function remindUserOfFollowUp(input: {
  userId: string;
  leadId: string;
  leadName: string;
  stepTitle: string;
  dueAt: Date;
}): Promise<void> {
  await notifyUser({
    userId: input.userId,
    kind: "followup_due",
    title: `⏰ Follow-up due — ${input.leadName}`,
    body: `${input.stepTitle} · was due ${formatIst(input.dueAt)}`,
    leadId: input.leadId,
    dedupeKey: `followup-user:${input.userId}:${input.leadId}:${input.dueAt.getTime()}`,
  });
}
