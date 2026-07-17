"use client";

// Per-lead quotes panel (Phase 2 §multi-quote). Shows every quote on the lead with
// its status, price, owner, and age, and lets a counsellor raise / revise / advance
// / reassign one. The lead is the person; each card is a treatment that converts on
// its own.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createLeadQuote,
  reviseLeadQuotePrice,
  setLeadQuoteStatus,
  setLeadQuoteOwner,
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
  ownerRepId: string | null;
  ownerName: string | null;
  expiresAt: string | null;
  convertedAt: string | null;
  lockedAt: string | null;
  createdAt: string;
};

type Rep = { id: string; name: string };

const inputCls =
  "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

// Statuses a counsellor can move a quote to. `awaiting_payment` isn't offered
// directly — "Accepted" advances there (acceptance ≠ conversion). `converted` is
// gated server-side to quotes.convert.
const NEXT_STATUSES: QuoteStatus[] = [
  "sent",
  "viewed",
  "accepted",
  "converted",
  "rejected",
  "expired",
  "withdrawn",
];

// Acceptance means "Accepted — Awaiting Payment"; label the action accordingly.
function actionLabel(s: QuoteStatus): string {
  return s === "accepted" ? "Accepted — Awaiting Payment" : QUOTE_STATUS_LABELS[s];
}

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
  reps,
  canManage,
}: {
  leadId: string;
  quotes: QuoteView[];
  reps: Rep[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [nq, setNq] = useState({ treatment: "", price: "", source: "" });
  // The quote+status awaiting a reason (reject → from list, withdraw → free text).
  const [reasonFor, setReasonFor] = useState<{ quoteId: string; status: "rejected" | "withdrawn" } | null>(null);
  const [reasonVal, setReasonVal] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else window.alert(res.error ?? "Action failed");
    });

  function chooseStatus(quoteId: string, status: string) {
    if (!status) return;
    if (status === "rejected" || status === "withdrawn") {
      setReasonFor({ quoteId, status });
      setReasonVal("");
      return;
    }
    if (status === "converted" && !window.confirm("Mark this quote converted? It will lock.")) return;
    run(() => setLeadQuoteStatus({ quoteId, leadId, status }));
  }

  function submitReason() {
    if (!reasonFor) return;
    const { quoteId, status } = reasonFor;
    if (!reasonVal.trim()) return;
    const payload =
      status === "rejected"
        ? { quoteId, leadId, status, rejectionReason: reasonVal }
        : { quoteId, leadId, status, withdrawnReason: reasonVal };
    run(() => setLeadQuoteStatus(payload).then((r) => { if (r.ok) setReasonFor(null); return r; }));
  }

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
            const awaitingReason = reasonFor?.quoteId === q.id;
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
                  <span>Owner: {q.ownerName ?? "—"}</span>
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
                      onChange={(e) => { chooseStatus(q.id, e.target.value); e.currentTarget.value = ""; }}
                    >
                      <option value="">Move to…</option>
                      {NEXT_STATUSES.filter((s) => s !== q.status).map((s) => (
                        <option key={s} value={s}>{actionLabel(s)}</option>
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

                    <label className="flex items-center gap-1 text-xs text-black/50 dark:text-white/50">
                      Owner
                      <select
                        className={inputCls}
                        defaultValue={q.ownerRepId ?? ""}
                        disabled={pending}
                        onChange={(e) => run(() => setLeadQuoteOwner({ quoteId: q.id, leadId, ownerRepId: e.target.value || null }))}
                      >
                        <option value="">Unassigned</option>
                        {reps.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </label>
                  </div>
                )}

                {/* Inline reason capture for reject (from list) / withdraw (free text). */}
                {awaitingReason && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-black/10 bg-black/2 p-2 dark:border-white/15 dark:bg-white/3">
                    {reasonFor!.status === "rejected" ? (
                      <select className={inputCls} value={reasonVal} onChange={(e) => setReasonVal(e.target.value)}>
                        <option value="">Rejection reason…</option>
                        {QUOTE_REJECTION_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <input
                        className={`${inputCls} min-w-[16rem]`}
                        placeholder="Why is this quote being withdrawn?"
                        value={reasonVal}
                        onChange={(e) => setReasonVal(e.target.value)}
                      />
                    )}
                    <button
                      disabled={pending || !reasonVal.trim()}
                      onClick={submitReason}
                      className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                    >
                      Confirm {reasonFor!.status}
                    </button>
                    <button className="text-xs text-black/50 hover:underline dark:text-white/50" onClick={() => setReasonFor(null)}>
                      Cancel
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
