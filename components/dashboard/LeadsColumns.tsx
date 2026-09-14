"use client";

// Leads per day, last eight days (§dashboard).
//
// One series, so no legend — the card's title says what is plotted, and a box
// with a single swatch would only restate it. Mark specs: bars capped at 24px
// so the band keeps its air, a 4px rounded top with a square foot on the
// baseline, and a hairline grid that stays behind the data.
//
// No direct labels at all: a number over every column is noise that stops
// being read, and the one over the busiest day was in the way. The busiest day
// is still marked — it carries the accent colour, and its date is set in the
// ink colour below — and the readout under the chart names any day on hover.
import { useState } from "react";

export function LeadsColumns({
  data,
}: {
  data: { day: string; label: string; value: number }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
  const total = data.reduce((n, d) => n + d.value, 0);

  // Whole-number ticks only, and never a repeated one. Splitting a max of 2 into
  // quarters gives 0, 1, 1, 2, 2 — an axis that appears to count the same number
  // twice, which is worse than no axis. Below five leads a day the scale just
  // counts; above it, it steps.
  const rawMax = Math.max(1, ...data.map((d) => d.value));
  const ticks =
    rawMax <= 4
      ? Array.from({ length: rawMax + 1 }, (_, i) => i)
      : [0, 1, 2, 3, 4].map((i) => i * Math.ceil(rawMax / 4));
  // Bars are measured against the top TICK, not the raw max, or a bar would
  // overshoot the gridline it is supposed to be read against.
  const max = ticks[ticks.length - 1];

  return (
    <div className="relative">
      <div className="flex h-[220px] gap-3">
        {/* Axis: the scale, set small and recessive. */}
        <div className="flex w-8 shrink-0 flex-col-reverse justify-between py-0 text-right text-[10px] tabular-nums text-cara-faint">
          {ticks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>

        <div className="relative flex-1">
          {/* Hairline grid, one step off the surface, drawn behind everything. */}
          <div aria-hidden className="absolute inset-0 flex flex-col-reverse justify-between">
            {ticks.map((_, i) => (
              <div key={i} className="h-px w-full" style={{ background: "var(--viz-grid)" }} />
            ))}
          </div>

          {/* The 2px surface gap between neighbours is what separates them —
              no stroke, which would add ink that isn't data. */}
          <div className="absolute inset-0 flex items-end justify-between gap-[2px]">
            {data.map((d, i) => {
              const h = max ? (d.value / max) * 100 : 0;
              const isPeak = i === peak && d.value > 0;
              return (
                <div
                  key={d.day}
                  className="group flex h-full flex-1 items-end justify-center"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className="w-full max-w-[24px] rounded-t-[4px] transition-opacity"
                    style={{
                      height: `${Math.max(h, d.value > 0 ? 2 : 0)}%`,
                      background: isPeak ? "var(--viz-bar-peak)" : "var(--viz-bar)",
                      opacity: hover === null || hover === i ? 1 : 0.45,
                    }}
                  />
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* Day labels, aligned to the same track as the bars. */}
      <div className="mt-2 flex gap-3">
        <div className="w-8 shrink-0" />
        <div className="flex flex-1 justify-between gap-[2px]">
          {data.map((d, i) => (
            <div
              key={d.day}
              className={`flex-1 text-center text-[10px] ${
                i === peak ? "text-cara-ink" : "text-cara-faint"
              }`}
            >
              {d.label.replace(" ", " ")}
            </div>
          ))}
        </div>
      </div>

      {/* Hover readout. Sits in a fixed slot rather than following the cursor,
          so it can never cover the bar being read. */}
      <div className="mt-3 h-5 text-[12px] text-cara-muted" aria-live="polite">
        {hover !== null ? (
          <span>
            <span className="font-medium text-cara-ink tabular-nums">{data[hover].value}</span>{" "}
            {data[hover].value === 1 ? "lead" : "leads"} on {data[hover].label}
          </span>
        ) : (
          <span className="text-cara-faint tabular-nums">{total} leads over these eight days</span>
        )}
      </div>
    </div>
  );
}
