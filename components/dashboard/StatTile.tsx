// A headline number with its month-on-month delta (§dashboard).
//
// A stat tile, not a one-bar chart: when the data is a single current value
// plus a trend, the number IS the chart. The corner arrow opens the screen the
// figure came from, so a number on a dashboard is never a dead end.
import Link from "next/link";
import { DeltaPill } from "./DeltaPill";
import type { StatFigure } from "@/lib/dashboardMetrics";

export function StatTile({ stat, featured = false }: { stat: StatFigure; featured?: boolean }) {
  return (
    <div className={`cara-card cara-card-hover relative p-3.5 ${featured ? "cara-tile-featured" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[1.1px] text-cara-muted">{stat.label}</div>
        <Link
          href={stat.href}
          aria-label={`Open ${stat.label}`}
          className="cara-tile-arrow"
          title={`Open ${stat.label}`}
        >
          <span aria-hidden>↗</span>
        </Link>
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="cara-stat-value font-semibold leading-none tabular-nums text-cara-ink">
          {stat.value}
        </span>
        <DeltaPill delta={stat.delta} inverse={stat.inverse} />
      </div>

      <div className="mt-1.5 text-[10px] text-cara-faint">This month vs last</div>
    </div>
  );
}
