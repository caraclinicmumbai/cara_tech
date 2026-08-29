"use client";

// Per-lead quotes panel (Phase 2 §multi-quote). Shows every quote on the lead with
// its status, price, owner, and age, and lets a counsellor raise / revise / advance
// / reassign one. The lead is the person; each card is a treatment that converts on
// its own.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatIstDate } from "@/lib/datetime";
import {
  createLeadQuote,
  reviseLeadQuotePrice,
  setLeadQuoteStatus,
  setLeadQuoteOwner,
  sendLeadQuoteWhatsApp,
  recordQuoteInvoiceAction,
  raiseCreditDisputeAction,
  decideCreditDisputeAction,
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
import type { CatalogGroups } from "@/lib/catalog";

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
  /// Invoices raised against THIS quote (§billing). Their existence is what makes it
  /// converted; the branch on them is the branch that earns the credit.
  invoices: {
    id: string;
    number: string;
    amount: number;
    currency: string;
    branchName: string;
    issuedAt: string;
    source: string;
    overrideReason: string | null;
  }[];
};

type Rep = { id: string; name: string };

/// Who holds the credit for a quote, and the state of its one dispute (§branch credit).
export type CreditInfo = {
  creditedBranchName: string | null;
  disputable: boolean;
  windowEndsAt: string | null;
  dispute: {
    id: string;
    status: string;
    reason: string;
    claimantBranchName: string;
    creditedBranchName: string;
    raisedAt: string;
    windowEndsAt: string;
    decidedAt: string | null;
    decisionNote: string | null;
  } | null;
};

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
  catalog,
  canManage,
  canViewHistory = false,
  windowOpen,
  templateConfigured,
  canRecordInvoice = false,
  branches = [],
  canDisputeCredit = false,
  canDecideDispute = false,
  credit = {},
}: {
  leadId: string;
  quotes: QuoteView[];
  reps: Rep[];
  catalog: CatalogGroups[];
  canManage: boolean;
  /// Staff who may pull the internal history summary (needs `calls.view` too — the
  /// document contains transcripts).
  canViewHistory?: boolean;
  windowOpen: boolean;
  templateConfigured: boolean;
  /// Admin-only: record an invoice by hand when billing hasn't sent one.
  canRecordInvoice?: boolean;
  branches?: { id: string; name: string }[];
  /// §branch credit — a branch manager may dispute a credit, the Sales Head decides.
  canDisputeCredit?: boolean;
  canDecideDispute?: boolean;
  credit?: Record<string, CreditInfo>;
}) {
  // WhatsApp can send the PDF if the 24h window is open (plain document) OR an
  // approved document template is configured (proactive send outside the window).
  const canSendWhatsApp = windowOpen || templateConfigured;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [nq, setNq] = useState({ catalogItemId: "", treatment: "", price: "", gstRate: String(DEFAULT_GST_RATE), discountValue: "", discountUnit: "percent", source: "" });
  const [catalogQuery, setCatalogQuery] = useState("");
  // The quote+status awaiting a reason (reject → from list, withdraw → free text).
  const [reasonFor, setReasonFor] = useState<{ quoteId: string; status: "rejected" | "withdrawn" } | null>(null);
  // Admin-only manual invoice entry: which quote's form is open, and its fields.
  const [invoiceFor, setInvoiceFor] = useState<string | null>(null);
  const [invForm, setInvForm] = useState({ number: "", branchId: "", amount: "", issuedAt: "", reason: "" });
  // §branch credit — which quote's dispute form is open, and the text in it.
  const [disputeFor, setDisputeFor] = useState<string | null>(null);
  const [disputeText, setDisputeText] = useState("");
  const [decideText, setDecideText] = useState("");
  const [reasonVal, setReasonVal] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        after?.();
        router.refresh();
      } else window.alert(res.error ?? "Action failed");
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

                {/* Price breakdown: base → −discount → +GST → total. */}
                {q.price != null && (() => {
                  const tt = computeQuoteTotals({ base: q.price, gstRate: q.gstRate, discountType: q.discountType, discountValue: q.discountValue });
                  return (
                    <div className="mt-1 text-xs text-black/50 dark:text-white/50">
                      Base {inr(q.price, q.currency)}
                      {q.discountType && q.discountValue
                        ? ` · Disc ${q.discountType === "percent" ? `${q.discountValue}%` : inr(q.discountValue, q.currency)} −${inr(tt.discountAmount, q.currency)}`
                        : ""}
                      {` · GST ${q.gstRate}% ${inr(tt.gstAmount, q.currency)}`}
                      {" · "}<span className="font-medium text-black/70 dark:text-white/70">Total {inr(q.totalPayable ?? tt.total, q.currency)}</span>
                    </div>
                  );
                })()}

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
                  {/* Internal history summary — converted quotes only, and only for
                      staff who can see calls (it carries transcripts). */}
                  {canViewHistory && isQuoteLocked(q.status) && (
                    <a
                      href={`/api/quotes/${q.id}/history`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Internal history summary: ownership, quotation, every conversation and contact. Not for the patient."
                      className="text-purple-700 hover:underline dark:text-purple-400"
                    >
                      🗂 History PDF
                    </a>
                  )}
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

                {/* §billing — the invoice is why this quote is converted, and the
                    branch on it is the branch that earns the credit. Shown as fact,
                    never as an editable field. */}
                {q.invoices.length > 0 && (
                  <div className="mt-2 space-y-0.5 rounded bg-green-600/10 px-2 py-1.5 text-xs">
                    {q.invoices.map((iv) => (
                      <div key={iv.id}>
                        🧾 Invoice <span className="font-medium">{iv.number}</span> ·{" "}
                        {iv.currency === "INR" ? "₹" : `${iv.currency} `}
                        {iv.amount.toLocaleString("en-IN")} · billed by{" "}
                        <span className="font-medium">{iv.branchName}</span> ·{" "}
                        <span suppressHydrationWarning>{formatIstDate(iv.issuedAt)}</span>
                        {iv.source === "manual_admin" && (
                          <span
                            title={iv.overrideReason ?? undefined}
                            className="ml-1 rounded bg-amber-500/20 px-1 py-px text-[10px] text-amber-800 dark:text-amber-300"
                          >
                            recorded by hand
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* §branch credit — the credit follows the invoice. It's shown as a
                    fact with one release valve: a 7-day dispute, decided once by the
                    Sales Head. Nobody edits the branch directly. */}
                {credit[q.id]?.creditedBranchName && (
                  <div className="mt-2 text-xs">
                    <span className="text-black/45 dark:text-white/45">Credit:</span>{" "}
                    <span className="font-medium">{credit[q.id].creditedBranchName}</span>
                    {credit[q.id].dispute ? (
                      <span
                        className={`ml-2 rounded px-1.5 py-px text-[10px] ${
                          credit[q.id].dispute!.status === "open"
                            ? "bg-amber-500/20 text-amber-800 dark:text-amber-300"
                            : credit[q.id].dispute!.status === "upheld"
                              ? "bg-green-600/20 text-green-800 dark:text-green-300"
                              : "bg-black/10 text-black/60 dark:bg-white/15 dark:text-white/60"
                        }`}
                        title={credit[q.id].dispute!.decisionNote ?? credit[q.id].dispute!.reason}
                      >
                        {credit[q.id].dispute!.status === "open"
                          ? `disputed by ${credit[q.id].dispute!.claimantBranchName}`
                          : credit[q.id].dispute!.status === "upheld"
                            ? "dispute upheld — credit moved"
                            : "dispute rejected — credit stands"}
                      </span>
                    ) : credit[q.id].disputable && canDisputeCredit ? (
                      <button
                        onClick={() => { setDisputeFor(disputeFor === q.id ? null : q.id); setDisputeText(""); }}
                        className="ml-2 text-blue-600 hover:underline dark:text-blue-400"
                        title={`Disputes close ${credit[q.id].windowEndsAt ? formatIstDate(credit[q.id].windowEndsAt!) : ""}`}
                      >
                        {disputeFor === q.id ? "Cancel" : "Dispute this credit"}
                      </button>
                    ) : null}
                  </div>
                )}

                {canDisputeCredit && disputeFor === q.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-blue-500/40 bg-blue-500/5 p-2">
                    <input
                      className={`${inputCls} min-w-64 flex-1`}
                      placeholder="Why is this credit your branch's? (final decision is the Sales Head's)"
                      value={disputeText}
                      onChange={(e) => setDisputeText(e.target.value)}
                    />
                    <button
                      disabled={pending || !disputeText.trim()}
                      className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                      onClick={() =>
                        run(
                          () => raiseCreditDisputeAction({ quoteId: q.id, leadId, reason: disputeText }),
                          () => { setDisputeFor(null); setDisputeText(""); },
                        )
                      }
                    >
                      Raise dispute
                    </button>
                  </div>
                )}

                {canDecideDispute && credit[q.id]?.dispute?.status === "open" && (
                  <div className="mt-2 space-y-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
                    <div>
                      <span className="font-medium">{credit[q.id].dispute!.claimantBranchName}</span> claims this
                      credit from <span className="font-medium">{credit[q.id].dispute!.creditedBranchName}</span>:
                      “{credit[q.id].dispute!.reason}”
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className={`${inputCls} min-w-64 flex-1`}
                        placeholder="Your decision and why (final, and logged)"
                        value={decideText}
                        onChange={(e) => setDecideText(e.target.value)}
                      />
                      <button
                        disabled={pending || !decideText.trim()}
                        className="rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        onClick={() =>
                          run(
                            () => decideCreditDisputeAction({ disputeId: credit[q.id].dispute!.id, leadId, uphold: true, note: decideText }),
                            () => setDecideText(""),
                          )
                        }
                      >
                        Uphold — move the credit
                      </button>
                      <button
                        disabled={pending || !decideText.trim()}
                        className="rounded border border-black/15 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-white/20"
                        onClick={() =>
                          run(
                            () => decideCreditDisputeAction({ disputeId: credit[q.id].dispute!.id, leadId, uphold: false, note: decideText }),
                            () => setDecideText(""),
                          )
                        }
                      >
                        Reject — credit stands
                      </button>
                    </div>
                  </div>
                )}

                {/* No invoice yet: say what conversion is waiting on, and let an
                    Admin record one when billing hasn't sent it. */}
                {canManage && q.invoices.length === 0 && !locked && (
                  <div className="mt-2 text-xs text-black/45 dark:text-white/45">
                    Not invoiced yet — this quote converts when billing raises its invoice.
                    {canRecordInvoice && (
                      <button
                        onClick={() => setInvoiceFor(invoiceFor === q.id ? null : q.id)}
                        className="ml-2 text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {invoiceFor === q.id ? "Cancel" : "Record it by hand"}
                      </button>
                    )}
                  </div>
                )}

                {canRecordInvoice && invoiceFor === q.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
                    <input
                      className={inputCls}
                      placeholder="Invoice number"
                      value={invForm.number}
                      onChange={(e) => setInvForm({ ...invForm, number: e.target.value })}
                    />
                    <select
                      className={inputCls}
                      value={invForm.branchId}
                      onChange={(e) => setInvForm({ ...invForm, branchId: e.target.value })}
                    >
                      <option value="">Invoiced by…</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                    <input
                      className={inputCls}
                      placeholder="Amount (₹)"
                      inputMode="numeric"
                      value={invForm.amount}
                      onChange={(e) => setInvForm({ ...invForm, amount: e.target.value })}
                    />
                    <input
                      className={inputCls}
                      type="date"
                      value={invForm.issuedAt}
                      onChange={(e) => setInvForm({ ...invForm, issuedAt: e.target.value })}
                    />
                    <input
                      className={`${inputCls} min-w-56 flex-1`}
                      placeholder="Why by hand? (logged)"
                      value={invForm.reason}
                      onChange={(e) => setInvForm({ ...invForm, reason: e.target.value })}
                    />
                    <button
                      disabled={pending || !invForm.number.trim() || !invForm.branchId || !invForm.amount.trim() || !invForm.reason.trim()}
                      className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
                      onClick={() =>
                        run(
                          () =>
                            recordQuoteInvoiceAction({
                              quoteId: q.id,
                              leadId,
                              invoiceNumber: invForm.number,
                              branchId: invForm.branchId,
                              amount: Number(invForm.amount.replace(/[^\d]/g, "")) || 0,
                              issuedAt: invForm.issuedAt || null,
                              reason: invForm.reason,
                            }),
                          () => {
                            setInvoiceFor(null);
                            setInvForm({ number: "", branchId: "", amount: "", issuedAt: "", reason: "" });
                          },
                        )
                      }
                    >
                      Record invoice
                    </button>
                  </div>
                )}

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
            const gstNum = nq.gstRate !== "" ? Number(nq.gstRate) : DEFAULT_GST_RATE;
            const preview = computeQuoteTotals({
              base: nq.price ? Number(nq.price.replace(/[,\s₹]/g, "")) : 0,
              gstRate: gstNum,
              discountType: nq.discountValue ? nq.discountUnit : null,
              discountValue: nq.discountValue ? Number(nq.discountValue) : null,
            });
            const reset = () => {
              setNq({ catalogItemId: "", treatment: "", price: "", gstRate: String(DEFAULT_GST_RATE), discountValue: "", discountUnit: "percent", source: "" });
              setCatalogQuery("");
            };

            // Flatten the catalog for lookup, and build the filtered <optgroup> list.
            const q = catalogQuery.trim().toLowerCase();
            const byId = new Map<string, { name: string; price: number; gstRate: number; discountValue: number | null }>();
            const groups = catalog.map((g) => ({
              label: g.label,
              cats: g.categories
                .map((c) => ({
                  category: c.category,
                  items: c.items.filter((it) => {
                    byId.set(it.id, { name: it.name, price: it.price, gstRate: it.gstRate, discountValue: it.discountValue });
                    return !q || it.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q);
                  }),
                }))
                .filter((c) => c.items.length > 0),
            }));
            const optLabel = (it: { name: string; price: number; gstRate: number; discountValue: number | null }) =>
              it.discountValue
                ? `${it.name} — ₹${it.price.toLocaleString("en-IN")} · ${it.discountValue}% off`
                : `${it.name} — ₹${it.price.toLocaleString("en-IN")}${it.gstRate === 0 ? " · no GST" : ""}`;
            const pickCatalog = (id: string) => {
              const it = byId.get(id);
              if (!it) { setNq({ ...nq, catalogItemId: "", treatment: "" }); return; }
              setNq({
                ...nq,
                catalogItemId: id,
                treatment: it.name,
                price: String(it.price),
                gstRate: String(it.gstRate),
                discountUnit: "percent",
                discountValue: it.discountValue != null ? String(it.discountValue) : "",
              });
            };
            return (
              <div className="space-y-3 rounded border border-black/10 p-3 dark:border-white/15">
                {/* Treatment picker — search + grouped dropdown from the catalog.
                    Selecting auto-fills price, GST and any package discount below. */}
                <div className="space-y-1.5">
                  <input className={`${inputCls} w-full`} placeholder="Search treatments & packages…" value={catalogQuery}
                    onChange={(e) => setCatalogQuery(e.target.value)} />
                  <select className={`${inputCls} w-full`} value={nq.catalogItemId} onChange={(e) => pickCatalog(e.target.value)}>
                    <option value="">Select a treatment…</option>
                    {groups.map((g) =>
                      g.cats.map((c) => (
                        <optgroup key={`${g.label}-${c.category}`} label={`${g.label} · ${c.category}`}>
                          {c.items.map((it) => (
                            <option key={it.id} value={it.id}>{optLabel(it)}</option>
                          ))}
                        </optgroup>
                      )),
                    )}
                  </select>
                </div>

                <div className="flex flex-wrap items-end gap-2">
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

                {/* Live breakdown — discount applied FIRST, then GST on the net. */}
                <div className="rounded bg-black/3 px-3 py-2 text-xs text-black/60 dark:bg-white/5 dark:text-white/60">
                  <div className="flex justify-between"><span>Base price</span><span>{inr(preview.base, "INR")}</span></div>
                  {preview.discountAmount > 0 && (
                    <div className="flex justify-between">
                      <span>Discount {nq.discountUnit === "percent" ? `${nq.discountValue}%` : inr(preview.discountValue ?? 0, "INR")}</span>
                      <span>−{inr(preview.discountAmount, "INR")}</span>
                    </div>
                  )}
                  {preview.discountAmount > 0 && (
                    <div className="flex justify-between text-black/45 dark:text-white/45"><span>After discount</span><span>{inr(preview.afterDiscount, "INR")}</span></div>
                  )}
                  <div className="flex justify-between">
                    <span>
                      GST {gstNum}%
                      {gstNum === DEFAULT_GST_RATE ? ` (${CGST_RATE}% CGST + ${SGST_RATE}% SGST)` : gstNum === 0 ? " (exempt)" : ""}
                    </span>
                    <span>+{inr(preview.gstAmount, "INR")}</span>
                  </div>
                  <div className="mt-1 flex justify-between border-t border-black/10 pt-1 font-semibold text-black/80 dark:border-white/15 dark:text-white/80">
                    <span>Total payable</span><span>{inr(preview.total, "INR")}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    disabled={pending || !nq.treatment.trim() || !nq.source}
                    className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
                    onClick={() =>
                      run(() =>
                        createLeadQuote({
                          leadId,
                          treatment: nq.treatment,
                          price: nq.price || null,
                          discountType: nq.discountValue ? nq.discountUnit : null,
                          discountValue: nq.discountValue || null,
                          gstRate: nq.gstRate || null,
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
