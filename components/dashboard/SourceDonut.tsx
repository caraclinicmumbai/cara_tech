"use client";

// Where leads come from (§dashboard) — part-to-whole, at a glance.
//
// **Why one hue and not five.** The reference this is modelled on uses five
// separate colours for its categories. This palette cannot: the brand rule bars
// green and red, and a validated check of six blue/violet hues put the worst
// adjacent pair at ΔE 5.6 for *normal* colour vision, far below the 15 floor —
// two slices most people could not tell apart, before considering colour
// blindness at all. A band that narrow cannot carry identity.
//
// So magnitude carries it instead: segments are ordered largest to smallest and
// darkest to lightest, which makes the ramp itself the ranking. Identity lives
// in the legend — name, count and share, in text — never in the colour alone.
//
// Capped at five segments; the tail is folded into "Other" upstream, because
// part-to-whole stops being readable at a glance past about six.
import { useState } from "react";

const SEQ = ["var(--viz-seq-1)", "var(--viz-seq-2)", "var(--viz-seq-3)", "var(--viz-seq-4)", "var(--viz-seq-5)"];

export function SourceDonut({ data }: { data: { label: string; value: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((n, d) => n + d.value, 0);

  const R = 54;
  const C = 2 * Math.PI * R;
  // A 2px gap in the surface colour is what separates touching segments.
  const GAP = 2;

  // Each arc's start is the sum of the shares before it. Computed per segment
  // rather than by accumulating into an outer variable — at five segments the
  // extra passes cost nothing, and nothing is mutated during render.
  const arcs = data.map((d, i) => {
    const share = total ? d.value / total : 0;
    const before = data.slice(0, i).reduce((n, x) => n + x.value, 0);
    return {
      ...d,
      share,
      len: Math.max(share * C - GAP, 0),
      offset: total ? (before / total) * C : 0,
      color: SEQ[i] ?? SEQ[SEQ.length - 1],
    };
  });

  if (total === 0) {
    return <p className="text-sm text-cara-faint">No leads yet.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0">
        <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Leads by source">
          <g transform="rotate(-90 70 70)">
            {arcs.map((a, i) => (
              <circle
                key={a.label}
                cx="70"
                cy="70"
                r={R}
                fill="none"
                stroke={a.color}
                strokeWidth={hover === i ? 20 : 16}
                strokeDasharray={`${a.len} ${C - a.len}`}
                strokeDashoffset={-a.offset}
                opacity={hover === null || hover === i ? 1 : 0.4}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width .12s, opacity .12s", cursor: "default" }}
              />
            ))}
          </g>
          {/* The centre carries the total — the hero number the ring is made of. */}
          <text
            x="70"
            y="66"
            textAnchor="middle"
            className="fill-cara-ink"
            style={{ fontSize: 26, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
          >
            {hover === null ? total : arcs[hover].value}
          </text>
          <text
            x="70"
            y="84"
            textAnchor="middle"
            className="fill-cara-faint"
            style={{ fontSize: 10, letterSpacing: 1 }}
          >
            {hover === null ? "LEADS" : arcs[hover].label.toUpperCase()}
          </text>
        </svg>
      </div>

      {/* The legend is the identity channel, and it carries the numbers so the
          ring never has to be read by colour-matching. */}
      <ul className="min-w-[170px] flex-1 space-y-1.5">
        {arcs.map((a, i) => (
          <li
            key={a.label}
            className="flex items-center gap-2 text-[13px]"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: a.color }}
            />
            <span className={hover === i ? "text-cara-ink" : "text-cara-muted"}>{a.label}</span>
            <span className="ml-auto tabular-nums text-cara-ink">{a.value}</span>
            <span className="w-10 text-right tabular-nums text-cara-faint">
              {Math.round(a.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
