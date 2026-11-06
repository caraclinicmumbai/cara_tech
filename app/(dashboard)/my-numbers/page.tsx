import { redirect } from "next/navigation";
import { currentUser } from "@/lib/authz";
import { landingPath } from "@/lib/rbac";
import { istToday, resolveRange } from "@/lib/reports/range";
import { isBucket } from "@/lib/reports/telecalling";
import { isSpeedResult } from "@/lib/reports/speedToCall";
import { ReportRangePicker } from "@/components/ReportRangePicker";
import { FollowUpSection, SpeedSection, TelecallingSection } from "../reports/sections/telecalling";

export const dynamic = "force-dynamic";

// A telecaller's own reports (§reports). No capability guards this: it reads the signed-in
// person's linked rep and nothing else, so it can't show anyone else's numbers.
export default async function MyNumbersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await currentUser();
  if (!user?.salesRepId) redirect(landingPath(user?.role));
  const repId = user.salesRepId;

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const range = resolveRange({ preset: str("preset"), from: str("from"), to: str("to") });

  const href = (extra: Record<string, string>) => {
    const q = new URLSearchParams();
    if (range.preset) q.set("preset", range.preset);
    else {
      q.set("from", range.fromDay);
      q.set("to", range.toDay);
    }
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `/my-numbers?${q.toString()}`;
  };
  const by = str("by");
  const result = str("result");

  return (
    <div className="space-y-8">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">Analysis</div>
        <h1 className="cara-title">My numbers</h1>
        <p className="cara-note mt-1">
          Your follow-ups, calls and speed to call{" "}
          <span className="text-cara-faint">· {range.label} ({range.days} days, IST)</span>
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="cara-eyebrow">Follow-ups</h2>
        <FollowUpSection repId={repId} />
      </section>

      <ReportRangePicker fromDay={range.fromDay} toDay={range.toDay} preset={range.preset} today={istToday()} />

      <section className="space-y-3">
        <h2 className="cara-eyebrow">Calls and appointments</h2>
        <TelecallingSection range={range} by={isBucket(by) ? by : "day"} repId={repId} href={href} />
      </section>

      <section className="space-y-3">
        <h2 className="cara-eyebrow">Speed to call</h2>
        <SpeedSection
          range={range}
          repId={repId}
          result={isSpeedResult(result) ? result : undefined}
          page={Number(str("page")) || 1}
          href={href}
        />
      </section>
    </div>
  );
}
