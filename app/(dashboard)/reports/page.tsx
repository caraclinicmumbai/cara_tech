import Link from "next/link";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { resolveRange, istToday, RANGE_PRESETS } from "@/lib/reports/range";
import { ReportRangePicker } from "@/components/ReportRangePicker";
import { InflowSection, AiContactSection, HandoffSection } from "./sections/funnel";
import { CounsellorSection, AttributionSection } from "./sections/people";
import { LostLeadSection, LostQuoteSection } from "./sections/lost";
import { TreatmentMixSection, MultiQuoteSection, RepeatSection } from "./sections/money";

export const dynamic = "force-dynamic";

// The report set (§reports). Ten read-outs over one shared date range, each on its own
// tab so a page load computes one report rather than ten.
//
// Two capabilities gate this. `reports.view` decides who reaches the page at all (the
// route guard in lib/rbac.ts); `reports.revenue` decides who sees the four money
// reports — they put per-treatment pricing and quote values on screen, which is not
// floor-level information. A tab the viewer can't hold simply isn't rendered, and its
// URL falls back to the first tab they can see rather than erroring.

type ReportKey =
  | "inflow"
  | "ai-contact"
  | "handoff"
  | "counsellors"
  | "attribution"
  | "lost-leads"
  | "treatment-mix"
  | "lost-quotes"
  | "multi-quote"
  | "repeat";

const TABS: { key: ReportKey; label: string; blurb: string; money: boolean }[] = [
  { key: "inflow", label: "Lead Inflow", blurb: "How many leads arrived, and from where.", money: false },
  { key: "ai-contact", label: "AI Contact Rate", blurb: "How many of them the AI actually reached.", money: false },
  { key: "handoff", label: "Handoff Speed", blurb: "How fast a counsellor picked up what the AI handed over.", money: false },
  { key: "counsellors", label: "Counsellor Performance", blurb: "Leads handled, consultations booked, what converted.", money: false },
  { key: "attribution", label: "Source Attribution", blurb: "Cost per lead, per consultation, per surgery.", money: false },
  { key: "lost-leads", label: "Lost Leads", blurb: "Why we lose people before they're ever quoted.", money: false },
  { key: "treatment-mix", label: "Treatment Mix", blurb: "What we quote, what converts, at what value.", money: true },
  { key: "lost-quotes", label: "Lost Quotes", blurb: "Quotes rejected, withdrawn or lapsed — and the pricing signal in them.", money: true },
  { key: "multi-quote", label: "Multi-Quote", blurb: "How often one patient buys two treatments, and which pairs go together.", money: true },
  { key: "repeat", label: "Repeat Treatment", blurb: "Who comes back, how long they take, what it's worth.", money: true },
];

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireCapability("reports.view");
  const showMoney = can(user.role, "reports.revenue");

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);

  const visible = TABS.filter((t) => showMoney || !t.money);
  const requested = str("r");
  const tab = visible.find((t) => t.key === requested) ?? visible[0];

  const range = resolveRange({ preset: str("preset"), from: str("from"), to: str("to") });

  // Carry the range across tab switches — changing report shouldn't reset the window.
  const tabHref = (key: ReportKey) => {
    const q = new URLSearchParams({ r: key });
    if (range.preset) q.set("preset", range.preset);
    else {
      q.set("from", range.fromDay);
      q.set("to", range.toDay);
    }
    return `/reports?${q.toString()}`;
  };

  return (
    <div className="space-y-6">
      <header className="cara-sec-hd">
        <div className="cara-eyebrow">Reports</div>
        <h1 className="cara-title">{tab.label}</h1>
        <p className="cara-note mt-1">
          {tab.blurb} <span className="text-cara-faint">· {range.label} ({range.days} days, IST)</span>
        </p>
      </header>

      <nav className="flex flex-wrap gap-1.5">
        {visible.map((t) => (
          <Link key={t.key} href={tabHref(t.key)} className={`cara-pill${t.key === tab.key ? " on" : ""}`}>
            {t.money && <span className="mr-1">₹</span>}
            {t.label}
          </Link>
        ))}
      </nav>

      <ReportRangePicker
        fromDay={range.fromDay}
        toDay={range.toDay}
        preset={range.preset}
        today={istToday()}
      />

      {/* One report per load. Each section runs its own queries against the range. */}
      {tab.key === "inflow" && <InflowSection range={range} />}
      {tab.key === "ai-contact" && <AiContactSection range={range} />}
      {tab.key === "handoff" && <HandoffSection range={range} />}
      {tab.key === "counsellors" && <CounsellorSection range={range} showMoney={showMoney} />}
      {tab.key === "attribution" && <AttributionSection range={range} showMoney={showMoney} />}
      {tab.key === "lost-leads" && <LostLeadSection range={range} />}
      {tab.key === "treatment-mix" && <TreatmentMixSection range={range} />}
      {tab.key === "lost-quotes" && <LostQuoteSection range={range} />}
      {tab.key === "multi-quote" && <MultiQuoteSection range={range} />}
      {tab.key === "repeat" && <RepeatSection range={range} />}

      <footer className="cara-note border-t-[0.5px] border-cara-rule pt-4 text-[11px] text-cara-faint">
        All dates are IST calendar days. Ranges are inclusive of both ends
        {range.preset && ` — "${RANGE_PRESETS.find((p) => p.key === range.preset)?.label}" ends today.`}
        {!showMoney && " The money reports are hidden from this role."}
      </footer>
    </div>
  );
}
