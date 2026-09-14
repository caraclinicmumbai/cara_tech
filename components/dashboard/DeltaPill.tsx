// The "+2.6% vs last month" pill (§dashboard).
//
// Normally this is the one place a dashboard reaches for green and red, and the
// brand forbids both. So direction is carried by the ARROW and the sentence,
// and colour only carries emphasis: Soft Sky for the ordinary case, pastel
// violet when the number is the one to look at. Colour is never the only
// channel — which is the accessibility rule anyway, since red/green is exactly
// the pair eight percent of men cannot separate.
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
      <span className="tone tone-neutral" title="Nothing in the comparison period">
        new
      </span>
    );
  }

  const arrow = delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "■";
  // "Good" here means the direction the clinic wants, which flips for lost leads.
  const good = delta.direction === "flat" || (delta.direction === "up") !== inverse;
  const tone = delta.direction === "flat" ? "tone-neutral" : good ? "tone-info" : "tone-critical";

  return (
    <span
      className={`tone ${tone} tabular-nums`}
      title={`${delta.pct > 0 ? "Up" : "Down"} ${Math.abs(delta.pct).toFixed(1)}% versus the same point last month`}
    >
      <span aria-hidden>{arrow}</span>
      {Math.abs(delta.pct).toFixed(1)}%
    </span>
  );
}
