import Link from "next/link";
import { requireCapability } from "@/lib/authz";
import { listActiveCampaigns } from "@/lib/campaigns/enrollments";
import { campaignsEnabled } from "@/lib/campaigns/types";
import { formatIst } from "@/lib/datetime";
import { StopCampaignButton } from "@/components/StopCampaignButton";

export const dynamic = "force-dynamic";

// Follow-up campaigns overview (§follow-up): every lead currently running a campaign, grouped
// by campaign type. Route-guarded to `campaigns.manage`; each row can be stopped in place.
export default async function CampaignsPage() {
  await requireCapability("campaigns.manage");
  const groups = await listActiveCampaigns();
  const enabled = campaignsEnabled();
  const total = groups.reduce((n, g) => n + g.count, 0);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Follow-up campaigns</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          {total} lead{total === 1 ? "" : "s"} currently in an active campaign. Automated messages follow the
          per-branch quiet hours and the 12-in-30 message ceiling; a reply stops everything.
        </p>
      </div>

      {!enabled && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Follow-up campaigns are turned off (<code>CAMPAIGNS_ENABLED</code> is not set). Existing enrollments are
          shown, but nothing new enrolls and no messages send until the engine is enabled.
        </div>
      )}

      {total === 0 ? (
        <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
          No leads are in an active campaign right now.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.type} className="space-y-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              {g.label}
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs font-normal text-black/60 dark:bg-white/10 dark:text-white/60">
                {g.count}
              </span>
              {g.routing && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-normal text-emerald-700 dark:text-emerald-400">
                  routing
                </span>
              )}
            </h2>
            <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
              <table className="min-w-full text-sm">
                <thead className="bg-black/5 text-left dark:bg-white/10">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-2">Lead</th>
                    <th className="whitespace-nowrap px-4 py-2">{g.routing ? "Type" : "Progress"}</th>
                    <th className="whitespace-nowrap px-4 py-2">{g.routing ? "Window ends" : "Next touch"}</th>
                    <th className="whitespace-nowrap px-4 py-2">Started</th>
                    <th className="whitespace-nowrap px-4 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {g.leads.map((l) => (
                    <tr key={l.enrollmentId} className="border-t border-black/5 dark:border-white/10">
                      <td className="whitespace-nowrap px-4 py-2">
                        <Link href={`/leads/${l.leadId}`} className="font-medium hover:underline">
                          {l.leadName}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {g.routing ? "Fast-track" : `${l.messagesSent}/${l.totalSteps} sent`}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{l.nextRunAt ? formatIst(new Date(l.nextRunAt)) : "—"}</td>
                      <td className="whitespace-nowrap px-4 py-2">{formatIst(new Date(l.startedAt))}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right">
                        <StopCampaignButton leadId={l.leadId} label="Stop" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
