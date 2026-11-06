// Telecalling reports on Slack (§reports): a team summary with a short analysis to the
// management channel, and each telecaller's own numbers to their DM.
//
//   Daily    20:00 IST, today so far, compared with yesterday up to the same time
//   Weekly   Monday 09:00 IST, last Monday to Sunday, compared with the week before
//   Monthly  1st 09:00 IST, last calendar month, compared with the month before
//
// The analysis is plain rules over the numbers rather than generated text, so each sentence can
// be traced to a figure on the Reports page. Counts and staff names only: no patient details
// leave the CRM. Scheduled the same way as the daily digest (lib/digest.ts). Best-effort: a
// Slack or database error is logged, never thrown.
import { Queue } from "bullmq";
import { bullConnection } from "@/lib/queue";
import { sendSlack, isSlackConfigured } from "@/lib/slack";
import { branchManagerChannel } from "@/lib/digest";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { addDays, istDayStart, istToday, resolveRange, type DateRange } from "@/lib/reports/range";
import { telecallingReport, type TelecallingReport } from "@/lib/reports/telecalling";
import { speedToCall, type SpeedReport } from "@/lib/reports/speedToCall";
import { telecallerActivity, type ActivityReport } from "@/lib/reports/telecallerActivity";
import { followUpTracking, type FollowUpReport } from "@/lib/reports/followUpTracking";
import { duration, pct, talkTime } from "@/lib/reports/shared";

export const TELECALLING_REPORT_QUEUE = "telecalling-report";

export const REPORT_PERIODS = ["daily", "weekly", "monthly"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

const PERIOD_WORDS: Record<ReportPeriod, { title: string; previous: string }> = {
  daily: { title: "Daily", previous: "yesterday at this time" },
  weekly: { title: "Weekly", previous: "the week before" },
  monthly: { title: "Monthly", previous: "the month before" },
};

const CRON: Record<ReportPeriod, string> = {
  daily: "0 20 * * *",
  weekly: "0 9 * * 1",
  monthly: "0 9 1 * *",
};

/// The period a report covers and the one it's compared with.
export function reportRanges(period: ReportPeriod, now: Date = new Date()): { current: DateRange; previous: DateRange } {
  const today = istToday(now);
  const days = (from: string, to: string) => resolveRange({ from, to }, now);
  if (period === "daily") {
    const yesterday = addDays(today, -1);
    const sinceMidnight = now.getTime() - istDayStart(today).getTime();
    const prior = days(yesterday, yesterday);
    return {
      current: { ...days(today, today), end: now },
      previous: { ...prior, end: new Date(prior.start.getTime() + sinceMidnight) },
    };
  }
  if (period === "weekly") {
    return {
      current: days(addDays(today, -7), addDays(today, -1)),
      previous: days(addDays(today, -14), addDays(today, -8)),
    };
  }
  const thisMonth = `${today.slice(0, 7)}-01`;
  const lastDay = addDays(thisMonth, -1);
  const lastMonth = `${lastDay.slice(0, 7)}-01`;
  const dayBefore = addDays(lastMonth, -1);
  return { current: days(lastMonth, lastDay), previous: days(`${dayBefore.slice(0, 7)}-01`, dayBefore) };
}

export type ReportNumbers = {
  calls: TelecallingReport;
  speed: SpeedReport;
  activity: ActivityReport;
  followUps: FollowUpReport;
};

/// How a figure moved, in words, or null when there's nothing honest to compare with.
function moved(now: number, before: number): string | null {
  if (before <= 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return "level";
  return change > 0 ? `up ${change}%` : `down ${-change}%`;
}

/// The short analysis: what changed and what needs someone's attention, four lines at most.
/// Small samples say nothing about a person, so per-person remarks need at least five leads.
export function buildAnalysis(
  current: ReportNumbers,
  previous: Pick<ReportNumbers, "calls" | "speed"> | null,
  period: ReportPeriod,
): string[] {
  const out: string[] = [];
  const t = current.calls.totals;
  const before = previous?.calls.totals;
  const prevWords = PERIOD_WORDS[period].previous;

  if (t.calls === 0 && current.speed.totals.leads === 0) {
    return ["No telecalling activity was recorded in this period."];
  }

  if (before) {
    const change = moved(t.calls, before.calls);
    if (change) out.push(`Calls ${change} on ${prevWords} (${t.calls} vs ${before.calls}).`);
    if (t.connectPct != null && before.connectPct != null && Math.abs(t.connectPct - before.connectPct) >= 5) {
      out.push(`Connect rate ${t.connectPct > before.connectPct ? "rose" : "fell"} to ${pct(t.connectPct)} from ${pct(before.connectPct)}.`);
    }
  }

  const speed = current.speed.totals;
  if (speed.withinPct != null) {
    let line = `${pct(speed.withinPct)} of new leads were called within 5 minutes`;
    const prior = previous?.speed.totals.withinPct;
    if (prior != null) line += ` (${pct(prior)} ${prevWords})`;
    line += ".";
    if (speed.notCalled > 0) line += ` ${speed.notCalled} still ${speed.notCalled === 1 ? "hasn't" : "haven't"} had a call.`;
    out.push(line);
  }
  const slowest = current.speed.reps
    .filter((r) => r.repId && r.withinPct != null && r.leads >= 5)
    .sort((a, b) => a.withinPct! - b.withinPct!)[0];
  if (slowest && speed.withinPct != null && slowest.withinPct! < speed.withinPct - 10) {
    out.push(`${slowest.repName} is furthest behind on speed: ${pct(slowest.withinPct)} within 5 minutes over ${slowest.leads} leads.`);
  }

  if (t.showed + t.noShows >= 3 && t.showPct != null && t.showPct < 70) {
    out.push(`Show rate is ${pct(t.showPct)}: ${t.noShows} no-show${t.noShows === 1 ? "" : "s"} against ${t.showed} who came.`);
  }

  const late = current.followUps.totals.missedToday + current.followUps.totals.overdue;
  if (late > 0) {
    const worst = current.followUps.reps[0];
    out.push(
      `${late} follow-up${late === 1 ? " is" : "s are"} late` +
        (worst && worst.missedToday + worst.overdue > 0
          ? `, most with ${worst.repName} (${worst.missedToday + worst.overdue}).`
          : "."),
    );
  }

  return out.length ? out.slice(0, 4) : ["Nothing unusual in this period."];
}

function teamMessage(
  period: ReportPeriod,
  rangeLabel: string,
  n: ReportNumbers,
  analysis: string[],
): { text: string; blocks: unknown[] } {
  const t = n.calls.totals;
  const speedByRep = new Map(n.speed.reps.map((r) => [r.repId, r]));
  const activeByRep = new Map(n.activity.reps.map((r) => [r.repId, r]));
  const followByRep = new Map(n.followUps.reps.map((r) => [r.repId, r]));

  const people = n.calls.reps.slice(0, 20).map((r) => {
    const s = speedByRep.get(r.repId);
    const a = activeByRep.get(r.repId);
    const f = followByRep.get(r.repId);
    return (
      `*${r.repName}:* ${r.calls} calls, ${r.connected} connected, ${talkTime(r.talkSeconds)} talk` +
      ` · ${pct(s?.withinPct ?? null)} in 5 min` +
      ` · ${pct(a?.activePct ?? null)} active` +
      ` · ${r.booked} booked` +
      ` · ${(f?.missedToday ?? 0) + (f?.overdue ?? 0)} follow-ups late`
    );
  });

  const title = `📞 ${PERIOD_WORDS[period].title} telecalling report: ${rangeLabel}`;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Calls:*\n${t.calls} (${t.connected} connected, ${pct(t.connectPct)})` },
        { type: "mrkdwn", text: `*Talk time:*\n${talkTime(t.talkSeconds)}, average ${talkTime(t.avgSeconds)}` },
        {
          type: "mrkdwn",
          text: `*Speed to call:*\n${pct(n.speed.totals.withinPct)} within 5 min, median ${duration(n.speed.totals.medianMs)}`,
        },
        { type: "mrkdwn", text: `*Appointments:*\n${t.booked} booked, ${t.showed} came, ${t.noShows} no-show` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Analysis*\n${analysis.map((a) => `• ${a}`).join("\n")}` } },
  ];
  if (people.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: people.join("\n").slice(0, 2900) } });
  return { text: `${title}. ${analysis.join(" ")}`, blocks };
}

function personalMessage(
  period: ReportPeriod,
  rangeLabel: string,
  repId: string,
  n: ReportNumbers,
): string | null {
  const c = n.calls.reps.find((r) => r.repId === repId);
  const s = n.speed.reps.find((r) => r.repId === repId);
  const f = n.followUps.reps.find((r) => r.repId === repId);
  const late = (f?.missedToday ?? 0) + (f?.overdue ?? 0);
  if (!c?.calls && !s?.leads && !c?.booked && !late) return null;
  return [
    `📞 *Your ${PERIOD_WORDS[period].title.toLowerCase()} numbers: ${rangeLabel}*`,
    `• Calls: ${c?.calls ?? 0}, ${c?.connected ?? 0} connected, ${talkTime(c?.talkSeconds ?? 0)} talk time`,
    `• New leads called within 5 minutes: ${pct(s?.withinPct ?? null)}${s?.notCalled ? ` (${s.notCalled} not called yet)` : ""}`,
    `• Appointments: ${c?.booked ?? 0} booked, ${c?.showed ?? 0} came, ${c?.noShows ?? 0} no-show`,
    `• Follow-ups: ${f?.missedToday ?? 0} missed today, ${f?.overdue ?? 0} overdue`,
  ].join("\n");
}

/// Compute and send one report. Returns false when Slack isn't set up or the send failed.
export async function sendTelecallingReport(period: ReportPeriod, now: Date = new Date()): Promise<boolean> {
  const channel = process.env.TELECALLING_REPORT_CHANNEL ?? branchManagerChannel();
  if (!isSlackConfigured() || !channel) {
    logger.warn(`Telecalling report (${period}) skipped: Slack or its channel isn't configured`);
    return false;
  }
  try {
    const { current, previous } = reportRanges(period, now);
    const [calls, speed, activity, followUps, prevCalls, prevSpeed] = await Promise.all([
      telecallingReport(current),
      speedToCall(current, { asOf: now }),
      telecallerActivity(current, { now }),
      followUpTracking({ now }),
      telecallingReport(previous),
      // A call made after that moment hadn't happened yet when the comparison window closed.
      speedToCall(previous, { asOf: period === "daily" ? previous.end : now }),
    ]);
    const numbers: ReportNumbers = { calls, speed, activity, followUps };
    const analysis = buildAnalysis(numbers, { calls: prevCalls, speed: prevSpeed }, period);
    const message = teamMessage(period, current.label, numbers, analysis);
    const sent = await sendSlack({ ...message, channel });

    // A DM only to a real member id: sendSlack sends anything it can't address to the shared
    // channel, which is no place for one person's numbers.
    const reps = await prisma.salesRep.findMany({
      where: { active: true, deletedAt: null, salesHead: false, slackUserId: { not: null } },
      select: { id: true, slackUserId: true },
    });
    for (const rep of reps) {
      if (!/^[UW][A-Z0-9]+$/.test(rep.slackUserId!.trim())) continue;
      const text = personalMessage(period, current.label, rep.id, numbers);
      if (text) await sendSlack({ text, channel: rep.slackUserId! }).catch(() => {});
    }
    logger.info(`Telecalling report (${period}) sent for ${current.label}`);
    return sent;
  } catch (err) {
    logger.error(`Telecalling report (${period}) failed: ${String(err)}`);
    return false;
  }
}

let _q: Queue | undefined;
function getQueue(): Queue {
  if (!_q) _q = new Queue(TELECALLING_REPORT_QUEUE, { connection: bullConnection });
  return _q;
}

/// Register the three repeatable jobs. Idempotent, as with the digest: safe on every worker boot.
export async function scheduleTelecallingReports(): Promise<void> {
  for (const period of REPORT_PERIODS) {
    await getQueue().add(
      period,
      { period },
      {
        repeat: { pattern: CRON[period], tz: "Asia/Kolkata" },
        jobId: `telecalling-report-${period}`,
        removeOnComplete: 30,
        removeOnFail: 30,
      },
    );
  }
  logger.info("Telecalling reports scheduled (daily 20:00, weekly Mon 09:00, monthly 1st 09:00 IST)");
}
