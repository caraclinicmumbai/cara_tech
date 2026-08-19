import Link from "next/link";
import { formatIst } from "@/lib/datetime";
import type { HandoverSummary } from "@/lib/postSales/handover";

// The handover summary (§post-sales "Handing Over Cleanly"). Rendered server-side —
// there is nothing interactive here, and keeping it out of the client bundle means the
// patient's details are never serialised into a payload that doesn't need them.
//
// Note what is NOT on this card: call recordings, transcripts, CQS scores. "The
// post-sales team sees the summary — not the full call recordings."

function inr(n: number | null, currency: string): string {
  if (n == null) return "—";
  const sym = currency === "INR" ? "₹" : `${currency} `;
  return `${sym}${n.toLocaleString("en-IN")}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="cara-label">{label}</div>
      <div className="text-[13px] text-cara-ink">{children}</div>
    </div>
  );
}

const CONSENT_COPY: Record<HandoverSummary["clinicalConsent"], { label: string; tone: string }> = {
  given: { label: "Given", tone: "cara-badge cara-badge-success" },
  // The normal case: nothing explicit recorded, and a patient under the clinic's care
  // is treated as consenting to care messages.
  assumed: { label: "Assumed (under care)", tone: "cara-badge" },
  withheld: { label: "Withheld — no automated care messages", tone: "cara-badge cara-badge-danger" },
};

export function HandoverSummaryCard({
  summary,
  generatedAt,
  canSeeLead,
}: {
  summary: HandoverSummary;
  /// When the permanent snapshot was taken. The card itself shows LIVE values.
  generatedAt: string | null;
  /// Only staff who hold `leads.view` get a link into the sales record — the clinical
  /// roles don't, which is what keeps them away from call recordings.
  canSeeLead: boolean;
}) {
  const consent = CONSENT_COPY[summary.clinicalConsent];

  return (
    <section className="cara-card space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="cara-sec-hd">Handover summary</h2>
        <span className="cara-note">
          {generatedAt ? `Handed over ${formatIst(generatedAt)}` : "Not yet snapshotted"} · shown live
        </span>
      </div>

      {summary.safetyFlags.length > 0 && (
        <div className="cara-callout cara-callout-danger space-y-1">
          <div className="font-semibold">Before you treat this patient</div>
          <ul className="list-disc space-y-0.5 pl-5">
            {summary.safetyFlags.map((f) => (
              <li key={f.key}>
                {f.label}
                {f.note && <span className="opacity-80"> — {f.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Patient">
          {summary.patientName}
          <div className="text-cara-muted">{summary.patientPhone}</div>
        </Field>

        <Field label="Procedure">
          {summary.procedure}
          {summary.cycle > 1 && <span className="text-cara-muted"> · session {summary.cycle}</span>}
        </Field>

        <Field label="Price">
          {inr(summary.totalPayable, summary.currency)}
          {summary.price != null && summary.totalPayable !== summary.price && (
            <div className="text-cara-muted">base {inr(summary.price, summary.currency)}</div>
          )}
          {summary.discountLabel && <div className="text-cara-muted">discount {summary.discountLabel}</div>}
        </Field>

        <Field label="Invoiced by">
          {summary.invoicedBranchName ? (
            <>
              {summary.invoicedBranchName}
              {summary.invoicedBranchCode && <span className="text-cara-muted"> ({summary.invoicedBranchCode})</span>}
            </>
          ) : (
            // Conversion means an invoice exists; if billing hasn't told us WHICH branch
            // raised it, say so plainly rather than showing the quoting branch as fact.
            <span className="text-warning">
              Not reported by billing{summary.raisedBranchName ? ` — quote raised at ${summary.raisedBranchName}` : ""}
            </span>
          )}
        </Field>

        <Field label="Language">{summary.language ?? <span className="text-cara-faint">Not recorded</span>}</Field>

        <Field label="Clinical consent">
          <span className={consent.tone}>{consent.label}</span>
        </Field>

        <Field label="Communication preferences">
          <ul className="space-y-0.5">
            {summary.commsPreferences.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Field>

        <Field label="Attribution">
          {summary.attribution ?? <span className="text-cara-faint">Not recorded</span>}
        </Field>

        <Field label="Sold by">
          {summary.soldBy ?? <span className="text-cara-faint">Unassigned</span>}
          {summary.convertedAt && <div className="text-cara-muted">converted {formatIst(summary.convertedAt)}</div>}
        </Field>
      </div>

      <div className="space-y-1">
        <div className="cara-label">Other quotes on this patient</div>
        <p className="text-[13px]">{summary.otherQuotesLabel}</p>
        {summary.otherQuotes.length > 0 && (
          <ul className="space-y-0.5 text-[12px] text-cara-muted">
            {summary.otherQuotes.map((q) => (
              <li key={q.id}>
                {q.treatment}
                {q.cycle > 1 && ` (session ${q.cycle})`} — {q.status.replace(/_/g, " ")}
                {q.open && <span className="text-warning"> · open</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1">
        <div className="cara-label">Notes from the counsellor</div>
        {summary.notes.length === 0 ? (
          <p className="text-[13px] text-cara-faint">No notes were recorded before handover.</p>
        ) : (
          <ul className="space-y-2">
            {summary.notes.map((n, i) => (
              <li key={`${n.at}-${i}`} className="rounded-lg bg-cara-tint px-3 py-2 text-[13px]">
                <div className="text-[11px] text-cara-faint">
                  {n.author} · {formatIst(n.at)}
                </div>
                <div className="whitespace-pre-wrap">{n.body}</div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-cara-faint">
          Counsellor notes only. Call recordings and transcripts stay with the sales team.
        </p>
      </div>

      {canSeeLead && (
        <Link href={`/leads/${summary.leadId}`} className="cara-note inline-block hover:underline">
          Open the full sales record →
        </Link>
      )}
    </section>
  );
}
