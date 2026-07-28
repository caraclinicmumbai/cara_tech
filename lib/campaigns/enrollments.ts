// Read models for surfacing follow-up campaigns in the UI (§follow-up). The engine
// (engine.ts) owns writes; this file is query-only — the per-lead card (lead detail) and
// the /campaigns overview both read through here.
import { prisma } from "@/lib/prisma";
import { CAMPAIGNS, CAMPAIGN_TYPES, isCampaignType, type CampaignType } from "@/lib/campaigns/types";

export type CampaignView = {
  id: string;
  leadId: string;
  type: CampaignType | string;
  label: string;
  routing: boolean;
  status: string; // active | completed | stopped
  isActive: boolean;
  /// Messages sent so far and the campaign's total scheduled steps (0 for a routing campaign).
  messagesSent: number;
  totalSteps: number;
  startedAt: string; // ISO
  nextRunAt: string | null; // ISO — next touch (or the routing window's end) while active
  lastSentAt: string | null; // ISO
  stopReason: string | null;
};

function label(type: string): string {
  return isCampaignType(type) ? CAMPAIGNS[type].label : type;
}
function isRouting(type: string): boolean {
  return isCampaignType(type) ? !!CAMPAIGNS[type].routing : false;
}
function totalSteps(type: string): number {
  return isCampaignType(type) ? CAMPAIGNS[type].steps.length : 0;
}

function toView(r: {
  id: string; leadId: string; campaignType: string; status: string; messagesSent: number;
  startedAt: Date; nextRunAt: Date | null; lastSentAt: Date | null; stopReason: string | null;
}): CampaignView {
  return {
    id: r.id,
    leadId: r.leadId,
    type: r.campaignType,
    label: label(r.campaignType),
    routing: isRouting(r.campaignType),
    status: r.status,
    isActive: r.status === "active",
    messagesSent: r.messagesSent,
    totalSteps: totalSteps(r.campaignType),
    startedAt: r.startedAt.toISOString(),
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    stopReason: r.stopReason,
  };
}

const SELECT = {
  id: true, leadId: true, campaignType: true, status: true, messagesSent: true,
  startedAt: true, nextRunAt: true, lastSentAt: true, stopReason: true,
} as const;

/// The lead's ACTIVE campaign if it has one, else its most recent enrollment (so a completed /
/// stopped one still shows as history). Null when the lead was never in a campaign.
export async function getLeadCampaign(leadId: string): Promise<CampaignView | null> {
  const active = await prisma.campaignEnrollment.findFirst({
    where: { leadId, status: "active" },
    select: SELECT,
  });
  const enr =
    active ??
    (await prisma.campaignEnrollment.findFirst({
      where: { leadId },
      orderBy: { startedAt: "desc" },
      select: SELECT,
    }));
  return enr ? toView(enr) : null;
}

export type CampaignGroup = {
  type: CampaignType;
  label: string;
  routing: boolean;
  count: number;
  leads: {
    enrollmentId: string;
    leadId: string;
    leadName: string;
    messagesSent: number;
    totalSteps: number;
    nextRunAt: string | null;
    startedAt: string;
  }[];
};

/// All ACTIVE enrollments, grouped by campaign type in display order, soonest-next-touch first
/// within each group. Powers the /campaigns overview. Caps at 1000 (ample for a single clinic).
export async function listActiveCampaigns(): Promise<CampaignGroup[]> {
  const rows = await prisma.campaignEnrollment.findMany({
    where: { status: "active" },
    orderBy: { nextRunAt: "asc" },
    take: 1000,
    select: { ...SELECT, lead: { select: { name: true } } },
  });

  const byType = new Map<string, CampaignGroup["leads"]>();
  for (const r of rows) {
    const list = byType.get(r.campaignType) ?? [];
    list.push({
      enrollmentId: r.id,
      leadId: r.leadId,
      leadName: r.lead?.name ?? "—",
      messagesSent: r.messagesSent,
      totalSteps: totalSteps(r.campaignType),
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      startedAt: r.startedAt.toISOString(),
    });
    byType.set(r.campaignType, list);
  }

  // Emit in the canonical campaign order; skip types with no active enrollments.
  return CAMPAIGN_TYPES.filter((t) => byType.has(t)).map((t) => ({
    type: t,
    label: CAMPAIGNS[t].label,
    routing: !!CAMPAIGNS[t].routing,
    count: byType.get(t)!.length,
    leads: byType.get(t)!,
  }));
}
