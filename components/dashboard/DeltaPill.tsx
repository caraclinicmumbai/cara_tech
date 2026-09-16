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
// lost leads, where a rise is green nowhere — 225% more lost leads reads
// tangerine, and a fall in them would read green.
import type { Delta } from "@/lib/dashboardMetrics";
import { IconUp, IconDown, IconFlat } from "@/components/Icon";

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
        <IconFlat size={11} className="tag-icon" />
        new
      </span>
    );
  }

  const up = delta.direction === "up";
  const flat = delta.direction === "flat";
  // "Good" means the direction the clinic wants, which inverts for lost leads.
  const good = flat || up !== inverse;
  const tone = flat ? "tag-neutral" : good ? "tag-lime" : "tag-tangerine";

  return (
    <span
      className={`tag ${tone} tabular-nums`}
      title={`${up ? "Up" : "Down"} ${Math.abs(delta.pct).toFixed(1)}% versus the same point last month`}
    >
      {flat ? <IconFlat size={11} className="tag-icon" /> : up ? <IconUp size={11} className="tag-icon" /> : <IconDown size={11} className="tag-icon" />}
      {Math.abs(delta.pct).toFixed(1)}%
    </span>
  );
}
