"use client";

// Per-lead quotes panel (Phase 2 §multi-quote). Shows every quote on the lead with
// its status, price, and age, and lets a counsellor raise / revise / advance one.
// The lead is the person; each card is a treatment that converts on its own.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createLeadQuote,
  reviseLeadQuotePrice,
  setLeadQuoteStatus,
} from "@/app/(dashboard)/leads/quoteActions";
import {
  QUOTE_STATUS_LABELS,
  QUOTE_SOURCE_LABELS,
  QUOTE_REJECTION_REASONS,
  isQuoteLocked,
  isQuoteOpen,
  type QuoteStatus,
} from "@/lib/quoteStages";
import { formatIst } from "@/lib/datetime";

export type QuoteView = {
  id: string;
  treatment: string;
  status: string;
  cycle: number;
  price: number | null;
  currency: string;
  source: string | null;
  expiresAt: string | null;
  convertedAt: string | null;
  lockedAt: string | null;
  createdAt: string;
};

const inputCls =
  "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

// The statuses a counsellor can move a quote to from the card (unlock/replace are
// handled elsewhere). `converted` is gated server-side to quotes.convert.
const NEXT_STATUSES: QuoteStatus[] = [
  "sent",
  "viewed",
  "accepted",
  "awaiting_payment",
  "converted",
  "rejected",
  "expired",
  "withdrawn",
];

function inr(price: number | null, currency: string): string {
  if (price == null) return "—";
  const sym = currency === "INR" ? "₹" : `${currency} `;
  return `${sym}${price.toLocaleString("en-IN")}`;
}

function statusTone(status: string): string {
  if (["converted", "in_treatment", "completed"].includes(status))
    return "bg-green-600/15 text-green-700 dark:text-green-400";
  if (["rejected", "expired", "withdrawn", "replaced"].includes(status))
    return "bg-red-500/15 text-red-700 dark:text-red-400";
  return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
}

export function QuotesPanel({
  leadId,
  quotes,
  canManage,
}: {
  leadId: string;
  quotes: QuoteView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [nq, setNq] = useState({ treatment: "", price: "", source: "" });

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else window.alert(res.error ?? "Action failed");
    });

  return (
    <div className="space-y-4">
      {quotes.length === 0 ? (
        <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
          No quotes yet. {canManage && "Raise one when the patient asks about a treatment."}
        </p>
      ) : (
        <ul className="space-y-3">
          {quotes.map((q) => {
            const locked = isQuoteLocked(q.status);
            return (
              <li key={q.id} className="rounded border border-black/10 p-4 dark:border-white/15">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="font-medium">{q.treatment}</span>
                  {q.cycle > 1 && (
                    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
                      cycle {q.cycle}
                    </span>
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusTone(q.status)}`}>
                    {QUOTE_STATUS_LABELS[q.status as QuoteStatus] ?? q.status}
                  </span>
                  {locked && (
                    <span title="Converted — read-only" className="text-xs text-black/40 dark:text-white/40">
                      🔒 locked
                    </span>
                  )}
                  <span className="ml-auto font-medium">{inr(q.price, q.currency)}</span>
                </div>

                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-black/50 dark:text-white/50">
                  {q.source && <span>{QUOTE_SOURCE_LABELS[q.source as keyof typeof QUOTE_SOURCE_LABELS] ?? q.source}</span>}
                  <span>Created {formatIst(q.createdAt)}</span>
                  {isQuoteOpen(q.status) && q.expiresAt && <span>Expires {formatIst(q.expiresAt)}</span>}
                  {q.convertedAt && <span>Converted {formatIst(q.convertedAt)}</span>}
                </div>

                {canManage && !locked && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      className={inputCls}
                      value=""
                      disabled={pending}
                      onChange={(e) => {
                        const status = e.target.value;
                        if (!status) return;
                        if (status === "rejected") {
                          const reason = window.prompt(
                            `Rejection reason (one of: ${QUOTE_REJECTION_REASONS.join(", ")}):`,
                          );
                          if (!reason) return;
                          run(() => setLeadQuoteStatus({ quoteId: q.id, leadId, status, rejectionReason: reason }));
                          return;
                        }
                        if (status === "converted" && !window.confirm("Mark this quote converted? It will lock.")) return;
                        run(() => setLeadQuoteStatus({ quoteId: q.id, leadId, status }));
                      }}
                    >
                      <option value="">Move to…</option>
                      {NEXT_STATUSES.filter((s) => s !== q.status).map((s) => (
                        <option key={s} value={s}>{QUOTE_STATUS_LABELS[s]}</option>
                      ))}
                    </select>

                    <button
                      disabled={pending}
                      className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                      onClick={() => {
                        const p = window.prompt("New price (whole rupees):", q.price?.toString() ?? "");
                        if (p == null || p === "") return;
                        run(() => reviseLeadQuotePrice({ quoteId: q.id, leadId, price: p }));
                      }}
                    >
                      Revise price
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        adding ? (
          <div className="flex flex-wrap items-end gap-2 rounded border border-black/10 p-3 dark:border-white/15">
            <input className={inputCls} placeholder="Treatment (e.g. Hair transplant)" value={nq.treatment}
              onChange={(e) => setNq({ ...nq, treatment: e.target.value })} />
            <input className={inputCls} placeholder="Price ₹ (optional)" value={nq.price}
              onChange={(e) => setNq({ ...nq, price: e.target.value })} />
            <select className={inputCls} value={nq.source} onChange={(e) => setNq({ ...nq, source: e.target.value })}>
              <option value="">Source…</option>
              {Object.entries(QUOTE_SOURCE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <button
              disabled={pending}
              className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
              onClick={() =>
                run(() =>
                  createLeadQuote({
                    leadId,
                    treatment: nq.treatment,
                    price: nq.price || null,
                    source: nq.source || null,
                  }).then((r) => {
                    if (r.ok) { setNq({ treatment: "", price: "", source: "" }); setAdding(false); }
                    return r;
                  }),
                )
              }
            >
              Add quote
            </button>
            <button className="text-sm text-black/50 hover:underline dark:text-white/50" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="rounded border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            + New quote
          </button>
        )
      )}
    </div>
  );
}
