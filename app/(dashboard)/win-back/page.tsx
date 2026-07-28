import { requireCapability } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { listLostForReview } from "@/lib/campaigns/winback";
import { campaignsEnabled } from "@/lib/campaigns/types";
import { LOST_PRESET_TAGS } from "@/lib/leadStages";
import { WinBackQueue } from "@/components/WinBackQueue";

export const dynamic = "force-dynamic";

// Dead-Lead review queue (§follow-up): Sales Head / Telecalling Head approves leads Lost in
// the last 30 days for one more automated try. Route-guarded to `campaigns.winback`.
export default async function WinBackPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; repId?: string }>;
}) {
  await requireCapability("campaigns.winback");
  const { reason, repId } = await searchParams;
  const filters = { reason, repId };

  const [rows, reps] = await Promise.all([
    listLostForReview(filters),
    prisma.salesRep.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Win-Back — lost lead review</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Leads marked <span className="font-medium">Lost</span> in the last 30 days. Approve one or a
          batch for <span className="font-medium">one more try</span> (the Dead-Lead campaign). Leads that
          were lost 90+ days ago are also re-approached automatically by the Win-Back campaign (max 4 a
          year). Guardrails still apply — opt-outs, exclusions, and the message ceiling are respected.
        </p>
      </div>
      <WinBackQueue
        rows={rows}
        reasons={[...LOST_PRESET_TAGS]}
        reps={reps}
        filters={filters}
        campaignsEnabled={campaignsEnabled()}
      />
    </div>
  );
}
