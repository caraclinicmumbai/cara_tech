// The "+6.1% vs last month" pill (§dashboard).
//
// Same construction as the status tags, per the supplied reference: a pastel
// ground, a saturated outline and matching ink, and the direction as a glyph in
// a tinted chip. Three channels rather than one, so which way the number moved
// survives greyscale, colour blindness and print — none of which a coloured
// number does on its own.
//
// Colour here says whether the movement is the one the clinic wants, not which
// way it went: the arrow already says that. Which is why the pill flips for
// lost leads, where a rise is not an achievement.
import type { Delta } from "@/lib/dashboardMetrics";

export function DeltaPill({
  delta,
  inverse = false,
}: {
  delta: Delta;
  /// True when up is bad news — lost leads, unreachable numbers.
  inverse?: boolean;
}) {
  if (delta.pct === null) {
    return (
      <span className="tag tag-neutral" title="Nothing in the comparison period">
        <span className="tag-icon" aria-hidden>
          ·
        </span>
        new
      </span>
    );
  }

  const up = delta.direction === "up";
  const flat = delta.direction === "flat";
  const arrow = flat ? "■" : up ? "▲" : "▼";
  // "Good" means the direction the clinic wants, which inverts for lost leads.
  const good = flat || up !== inverse;
  const tone = flat ? "tag-neutral" : good ? "tag-blue" : "tag-tangerine";

  return (
    <span
      className={`tag ${tone} tabular-nums`}
      title={`${up ? "Up" : "Down"} ${Math.abs(delta.pct).toFixed(1)}% versus the same point last month`}
    >
      <span className="tag-icon" aria-hidden>
        {arrow}
      </span>
      {Math.abs(delta.pct).toFixed(1)}%
    </span>
  );
}
