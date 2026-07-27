// The follow-up guardrail gate (Phase 2 §follow-up). EVERY campaign send passes through
// checkEligibility() first — this is where the four patient-protection rules live. The
// engine never sends without an { ok: true } here.
//
// The rules (spec §"The Rules That Protect Patients"):
//   1. Hard exclusions — possible-minor / legal-threat / complaint (and soft-deleted).
//      No toggle can override these. → STOP the enrollment.
//   2. Opt-out — the hard `optedOut` suppression. → STOP.
//   3. Reply-stops-everything — any inbound since the campaign started means a human is
//      now talking; the system must never talk over them. → STOP. (Also enforced live at
//      the inbound webhook; re-checked here to close the race.)
//   4a. The 12-in-30 ceiling — max 12 automated messages to a PERSON in 30 days, across
//       ALL campaigns/quotes/channels. → DEFER until a slot frees.
//   4b. Branch quiet hours — never send inside the branch's quiet window. → DEFER.
//   4c. Per-branch on/off toggle — campaign disabled for this branch. → PAUSE (re-check
//       later; unlike a STOP this is reversible when the toggle flips back on).
import type { Lead, CampaignEnrollment } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isWithinQuietHours, nextAfterQuietHours, resolveQuietWindow } from "@/lib/campaigns/quietHours";

/// Max automated messages to one person in a rolling 30-day window (across everything).
export const CEILING_MAX = 12;
export const CEILING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/// The gate outcome. `stop` is terminal (end the enrollment); `defer` reschedules the next
/// attempt to `until`; `pause` skips this tick without ending the enrollment.
export type Gate =
  | { ok: true }
  | { ok: false; action: "stop"; reason: string }
  | { ok: false; action: "defer"; until: Date; reason: string }
  | { ok: false; action: "pause"; reason: string };

/// A persistent exclusion reason, or null if the lead is not hard-excluded. Exported so
/// enrollLead() can refuse to enrol an already-excluded lead using the same logic.
export function hardExclusion(lead: Pick<Lead, "possibleMinor" | "legalThreatFreeze" | "complaintOpen" | "deletedAt">): string | null {
  if (lead.deletedAt) return "lead deleted";
  if (lead.possibleMinor) return "possible minor";
  if (lead.legalThreatFreeze) return "legal-threat freeze";
  if (lead.complaintOpen) return "open complaint";
  return null;
}

/// Count automated outbound messages to a lead in the trailing 30 days and, if the ceiling
/// is hit, compute when the oldest of the most recent 12 ages out (freeing a slot).
async function ceilingCheck(leadId: string, now: Date): Promise<{ ok: true } | { ok: false; until: Date }> {
  const windowStart = new Date(now.getTime() - CEILING_WINDOW_MS);
  const recent = await prisma.message.findMany({
    where: { leadId, direction: "outbound", automated: true, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "desc" },
    take: CEILING_MAX,
    select: { createdAt: true },
  });
  if (recent.length < CEILING_MAX) return { ok: true };
  // The 12th-newest message ages out of the window at +30d; the count drops below the
  // ceiling then. (Any messages older than it have already aged out.) +1min buffer.
  const twelfth = recent[recent.length - 1]!.createdAt;
  return { ok: false, until: new Date(twelfth.getTime() + CEILING_WINDOW_MS + 60_000) };
}

/// Run the full gate for one enrollment. `lead` must be the current row (fresh flags).
export async function checkEligibility(
  lead: Lead,
  enr: Pick<CampaignEnrollment, "campaignType" | "branchId" | "startedAt">,
  now: Date = new Date(),
): Promise<Gate> {
  // 1. Hard exclusions — override every toggle.
  const excluded = hardExclusion(lead);
  if (excluded) return { ok: false, action: "stop", reason: `excluded (${excluded})` };

  // 2. Opt-out.
  if (lead.optedOut) return { ok: false, action: "stop", reason: "opted out" };

  // 3. Reply-stops-everything: any inbound message since the campaign started.
  const replied = await prisma.message.findFirst({
    where: { leadId: lead.id, direction: "inbound", createdAt: { gte: enr.startedAt } },
    select: { id: true },
  });
  if (replied) return { ok: false, action: "stop", reason: "lead replied" };

  // Resolve the branch's toggle + quiet hours in one read (null branch = defaults, on).
  const branch = enr.branchId
    ? await prisma.branch.findUnique({
        where: { id: enr.branchId },
        select: { quietStartHour: true, quietEndHour: true },
      })
    : null;
  const setting = enr.branchId
    ? await prisma.campaignSetting.findUnique({
        where: { branchId_campaignType: { branchId: enr.branchId, campaignType: enr.campaignType } },
        select: { enabled: true },
      })
    : null;

  // 4c. Per-branch toggle (absence = enabled). Reversible → pause, not stop.
  if (setting && setting.enabled === false) {
    return { ok: false, action: "pause", reason: "campaign disabled for branch" };
  }

  // 4a. The 12-in-30 person-level ceiling.
  const ceiling = await ceilingCheck(lead.id, now);
  if (!ceiling.ok) return { ok: false, action: "defer", until: ceiling.until, reason: "12-in-30 ceiling" };

  // 4b. Branch quiet hours.
  const window = resolveQuietWindow(branch?.quietStartHour, branch?.quietEndHour);
  if (isWithinQuietHours(window, now)) {
    return { ok: false, action: "defer", until: nextAfterQuietHours(window, now), reason: "quiet hours" };
  }

  return { ok: true };
}
