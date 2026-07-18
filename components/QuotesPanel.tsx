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
  sendLeadQuoteWhatsApp,
} from "@/app/(dashboard)/leads/quoteActions";
import {
  QUOTE_STATUS_LABELS,
  QUOTE_SOURCE_LABELS,
  QUOTE_REJECTION_REASONS,
  CGST_RATE,
  SGST_RATE,
  DEFAULT_GST_RATE,
  computeQuoteTotals,
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
  gstRate: number;
  discountType: string | null;
  discountValue: number | null;
  totalPayable: number | null;
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
  windowOpen,
  templateConfigured,
}: {
  leadId: string;
  quotes: QuoteView[];
  reps: Rep[];
  canManage: boolean;
  windowOpen: boolean;
  templateConfigured: boolean;
}) {
  // WhatsApp can send the PDF if the 24h window is open (plain document) OR an
  // approved document template is configured (proactive send outside the window).
  const canSendWhatsApp = windowOpen || templateConfigured;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [nq, setNq] = useState({ treatment: "", price: "", discountValue: "", discountUnit: "percent", source: "" });
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
                  <span className="ml-auto font-semibold">{inr(q.totalPayable ?? q.price, q.currency)}</span>
                </div>

                {/* Price breakdown: base → +GST → −discount → total. */}
                {q.price != null && (
                  <div className="mt-1 text-xs text-black/50 dark:text-white/50">
                    Base {inr(q.price, q.currency)} · GST {q.gstRate}% {inr(computeQuoteTotals({ base: q.price, gstRate: q.gstRate }).gstAmount, q.currency)}
                    {q.discountType && q.discountValue
                      ? ` · Disc ${q.discountType === "percent" ? `${q.discountValue}%` : inr(q.discountValue, q.currency)} −${inr(computeQuoteTotals({ base: q.price, gstRate: q.gstRate, discountType: q.discountType, discountValue: q.discountValue }).discountAmount, q.currency)}`
                      : ""}
                    {" · "}<span className="font-medium text-black/70 dark:text-white/70">Total {inr(q.totalPayable, q.currency)}</span>
                  </div>
                )}

                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-black/50 dark:text-white/50">
                  {q.source && <span>{QUOTE_SOURCE_LABELS[q.source as keyof typeof QUOTE_SOURCE_LABELS] ?? q.source}</span>}
                  <span>Owner: {q.ownerName ?? "—"}</span>
                  <span>Created {formatIst(q.createdAt)}</span>
                  {isQuoteOpen(q.status) && q.expiresAt && <span>Expires {formatIst(q.expiresAt)}</span>}
                  {q.convertedAt && <span>Converted {formatIst(q.convertedAt)}</span>}
                </div>

                {/* PDF + send (§multi-quote: send from inside the lead record). */}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <a
                    href={`/api/quotes/${q.id}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    📄 PDF
                  </a>
                  {canManage && (
                    <button
                      disabled={pending || !canSendWhatsApp}
                      title={
                        windowOpen
                          ? "Send this quote PDF on WhatsApp"
                          : templateConfigured
                            ? "Window closed — will send via the approved document template"
                            : "WhatsApp 24h window is closed and no document template is configured"
                      }
                      onClick={() => {
                        if (!window.confirm("Send this quote PDF to the lead on WhatsApp?")) return;
                        run(() => sendLeadQuoteWhatsApp({ quoteId: q.id, leadId }));
                      }}
                      className="text-green-700 hover:underline disabled:cursor-not-allowed disabled:text-black/30 disabled:no-underline dark:text-green-400 dark:disabled:text-white/30"
                    >
                      Send on WhatsApp
                    </button>
                  )}
                  {canManage && !windowOpen && (
                    <span className="text-black/40 dark:text-white/40">
                      {templateConfigured ? "(via template)" : "(window closed)"}
                    </span>
                  )}
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
          (() => {
            const preview = computeQuoteTotals({
              base: nq.price ? Number(nq.price.replace(/[,\s₹]/g, "")) : 0,
              gstRate: DEFAULT_GST_RATE,
              discountType: nq.discountValue ? nq.discountUnit : null,
              discountValue: nq.discountValue ? Number(nq.discountValue) : null,
            });
            const reset = () => setNq({ treatment: "", price: "", discountValue: "", discountUnit: "percent", source: "" });
            return (
              <div className="space-y-3 rounded border border-black/10 p-3 dark:border-white/15">
                <div className="flex flex-wrap items-end gap-2">
                  <input className={inputCls} placeholder="Treatment (e.g. Hair transplant)" value={nq.treatment}
                    onChange={(e) => setNq({ ...nq, treatment: e.target.value })} />
                  <input className={inputCls} placeholder="Base price ₹" inputMode="numeric" value={nq.price}
                    onChange={(e) => setNq({ ...nq, price: e.target.value })} />
                  <div className="flex items-stretch">
                    <input className={`${inputCls} w-28 rounded-r-none`} placeholder="Discount" inputMode="decimal" value={nq.discountValue}
                      onChange={(e) => setNq({ ...nq, discountValue: e.target.value })} />
                    <select className={`${inputCls} rounded-l-none border-l-0`} value={nq.discountUnit}
                      onChange={(e) => setNq({ ...nq, discountUnit: e.target.value })}>
                      <option value="percent">%</option>
                      <option value="inr">₹</option>
                    </select>
                  </div>
                  <select className={inputCls} value={nq.source} onChange={(e) => setNq({ ...nq, source: e.target.value })}>
                    <option value="">Source…</option>
                    {Object.entries(QUOTE_SOURCE_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>

                {/* Live breakdown — GST (fixed) applied before the discount. */}
                <div className="rounded bg-black/3 px-3 py-2 text-xs text-black/60 dark:bg-white/5 dark:text-white/60">
                  <div className="flex justify-between"><span>Base price</span><span>{inr(preview.base, "INR")}</span></div>
                  <div className="flex justify-between">
                    <span>GST {DEFAULT_GST_RATE}% ({CGST_RATE}% CGST + {SGST_RATE}% SGST)</span>
                    <span>+{inr(preview.gstAmount, "INR")}</span>
                  </div>
                  {preview.discountAmount > 0 && (
                    <div className="flex justify-between">
                      <span>Discount {nq.discountUnit === "percent" ? `${nq.discountValue}%` : inr(preview.discountValue ?? 0, "INR")}</span>
                      <span>−{inr(preview.discountAmount, "INR")}</span>
                    </div>
                  )}
                  <div className="mt-1 flex justify-between border-t border-black/10 pt-1 font-semibold text-black/80 dark:border-white/15 dark:text-white/80">
                    <span>Total payable</span><span>{inr(preview.total, "INR")}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    disabled={pending}
                    className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
                    onClick={() =>
                      run(() =>
                        createLeadQuote({
                          leadId,
                          treatment: nq.treatment,
                          price: nq.price || null,
                          discountType: nq.discountValue ? nq.discountUnit : null,
                          discountValue: nq.discountValue || null,
                          source: nq.source || null,
                        }).then((r) => {
                          if (r.ok) { reset(); setAdding(false); }
                          return r;
                        }),
                      )
                    }
                  >
                    Add quote
                  </button>
                  <button className="text-sm text-black/50 hover:underline dark:text-white/50" onClick={() => { reset(); setAdding(false); }}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          })()
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
