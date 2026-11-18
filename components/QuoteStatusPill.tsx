import type { CSSProperties } from "react";
import { pillInk } from "@/lib/stageColors";

// A quotation status in its colour — the clinic's choice from Settings → Colours, passed in
// from the pipeline (lib/pipeline.ts). The same pill on the lead's quote panel and on the
// Open Quotes board; the text is black or white, whichever reads better on it.
export function QuoteStatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span className="quote-pill" style={{ "--pill-bg": color, "--pill-fg": pillInk(color) } as CSSProperties}>
      {label}
    </span>
  );
}
