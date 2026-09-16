// The two "someone is waiting" cards (§dashboard).
//
// Everything else on this screen reports what happened. These two say what has
// not happened yet and is sitting there — the only figures on the dashboard a
// person can act on this minute, which is why they get a whole card and a
// number set at hero size rather than a row in a table.
import type { ReactNode } from "react";
import Link from "next/link";

export function QueueCard({
  icon,
  count,
  noun,
  waiting,
  href,
  linkLabel,
}: {
  icon: ReactNode;
  count: number;
  noun: string;
  /// The sentence under the number, phrased as what is owed to whom.
  waiting: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="cara-card cara-card-hover flex flex-col justify-between p-4">
      <div className="flex items-start justify-between">
        <span className="cara-queue-icon">{icon}</span>
        <Link href={href} aria-label={linkLabel} className="cara-tile-arrow" title={linkLabel}>
          <span aria-hidden>↗</span>
        </Link>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline gap-2">
          <span className="cara-stat-hero font-semibold leading-none tabular-nums text-cara-ink">
            {count}
          </span>
          <span className="text-[14px] text-cara-muted">{noun}</span>
        </div>
        <p className="mt-1.5 text-[12px] text-cara-muted">
          {count === 0 ? (
            <span className="text-cara-faint">Nothing waiting — the queue is clear.</span>
          ) : (
            waiting
          )}
        </p>
      </div>
    </div>
  );
}
