import Link from "next/link";
import { requireCapability } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { BUILT_IN_POLICY_KEYS, builtInPolicy, parseCheckInDays, parseStageDays } from "@/lib/postSales/policy";
import { TreatmentPolicyAdmin, type PolicyRow } from "@/components/TreatmentPolicyAdmin";

export const dynamic = "force-dynamic";

// Per-treatment stage time limits (§post-sales: "Time limits per stage, per treatment
// type. Hair transplant recovery is not PRP recovery. Overdue = alert.").
//
// Every treatment the app knows about is listed, whether or not it has been customised —
// an un-customised row shows the built-in numbers the clock is currently using, so an
// admin can see the live timings rather than an empty screen.

export default async function PostSalesPoliciesPage() {
  await requireCapability("postsales.policy");

  const saved = await prisma.treatmentStagePolicy.findMany({ orderBy: { treatmentType: "asc" } });
  const savedByKey = new Map(saved.map((r) => [r.treatmentType, r]));

  // Built-ins first (in their declared order), then any custom key an admin added.
  const keys = [...BUILT_IN_POLICY_KEYS, ...saved.map((r) => r.treatmentType).filter((k) => !BUILT_IN_POLICY_KEYS.includes(k))];

  const rows: PolicyRow[] = keys.map((key) => {
    const row = savedByKey.get(key);
    const built = builtInPolicy(key);
    if (!row) {
      return {
        treatmentType: key,
        label: built.label,
        stageDays: built.stageDays as Record<string, number>,
        checkInDays: built.checkInDays,
        active: true,
        isDefault: key === "default",
        configured: false,
      };
    }
    const stageDays = parseStageDays(row.stageDays);
    const checkInDays = parseCheckInDays(row.checkInDays);
    return {
      treatmentType: key,
      label: row.label || built.label,
      // A saved row that parses to nothing falls back to the built-ins at read time
      // (see getPolicy), so show what the clock is actually using.
      stageDays: (Object.keys(stageDays).length ? stageDays : built.stageDays) as Record<string, number>,
      checkInDays: checkInDays.length ? checkInDays : built.checkInDays,
      active: row.active,
      isDefault: row.isDefault,
      configured: true,
    };
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/post-sales" className="cara-eyebrow hover:underline">
          ← Post-Sales
        </Link>
        <h1 className="cara-title">Stage time limits</h1>
        <p className="cara-note">
          How long a treatment may sit in each clinical stage before it counts as overdue, and which days after surgery
          the care check-ins go out. A stage left blank has no limit and never goes overdue.
        </p>
      </div>

      <div className="cara-callout cara-callout-info">
        Changing a limit re-times journeys from their <em>next</em> stage move — a journey already in flight keeps the
        due date it was given when it entered its current stage.
      </div>

      <TreatmentPolicyAdmin rows={rows} />
    </div>
  );
}
