import type { CSSProperties } from "react";
import { quoteStatusColor } from "@/lib/stageColors";

// A quotation status in its colour (lib/stageColors.ts) — the same pill on the lead's quote
// panel and on the Open Quotes board.
export function QuoteStatusPill({ status, label }: { status: string; label: string }) {
  const { bg, fg } = quoteStatusColor(status);
  return (
    <span className="quote-pill" style={{ "--pill-bg": bg, "--pill-fg": fg } as CSSProperties}>
      {label}
    </span>
  );
}
