// Per-lead follow-up campaign card (§follow-up) — shows on the lead detail page. Renders the
// lead's active campaign (or most recent, as history) with a Stop action for staff who may
// manage campaigns. Server component; the Stop button inside is the client island.
import { formatIst } from "@/lib/datetime";
import type { CampaignView } from "@/lib/campaigns/enrollments";
import { StopCampaignButton } from "@/components/StopCampaignButton";

export function LeadCampaignCard({ campaign, canStop }: { campaign: CampaignView; canStop: boolean }) {
  const { isActive } = campaign;

  // Inactive → a muted one-line history note, no action.
  if (!isActive) {
    return (
      <div className="rounded border border-black/10 bg-black/[0.03] px-3 py-2 text-sm text-black/60 dark:border-white/15 dark:bg-white/[0.03] dark:text-white/60">
        🎯 Last campaign: <span className="font-medium">{campaign.label}</span> — {campaign.status}
        {campaign.stopReason ? ` (${campaign.stopReason})` : ""}
        {campaign.lastSentAt ? `, last message ${formatIst(new Date(campaign.lastSentAt))}` : ""}.
      </div>
    );
  }

  const next = campaign.nextRunAt ? formatIst(new Date(campaign.nextRunAt)) : null;
  const detail = campaign.routing
    ? `Fast-track routing — a counsellor should call this lead.${next ? ` Window ends ${next}.` : ""}`
    : `${campaign.messagesSent}/${campaign.totalSteps} messages sent.${next ? ` Next touch ${next}.` : ""}`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        🎯 <span className="font-medium">In campaign: {campaign.label}.</span> {detail}
      </div>
      {canStop && <StopCampaignButton leadId={campaign.leadId} />}
    </div>
  );
}
