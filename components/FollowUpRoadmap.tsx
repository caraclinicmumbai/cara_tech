"use client";

import { useState, useTransition } from "react";
import { formatIst } from "@/lib/datetime";
import type { FollowUpStepView } from "@/lib/followups";
import {
  addFollowUpStep,
  completeFollowUpStep,
  skipFollowUpStep,
  reopenFollowUpStep,
  reassignFollowUpStep,
  deleteFollowUpStep,
} from "@/app/(dashboard)/leads/followUpActions";

type Rep = { id: string; name: string; salesHead: boolean };

// The per-lead follow-up roadmap (§follow-up roadmap): an ordered, colour-coded
// sales roadmap. Done = green, missed (overdue + not done) = red, to-do = yellow,
// skipped = grey. Each step shows its accountable actor (a rep, the sales head, or
// AI) and — for editors — inline controls to complete/skip/reopen/reassign/remove.

const CHANNEL_ICON: Record<string, string> = {
  ai_call: "🤖",
  call: "📞",
  whatsapp: "💬",
  quote: "📄",
  custom: "•",
};

const VISUAL: Record<string, { label: string; badge: string; dot: string }> = {
  done: {
    label: "Done",
    badge: "bg-green-600/15 text-green-700 dark:text-green-400",
    dot: "bg-green-600 dark:bg-green-500",
  },
  missed: {
    label: "Missed",
    badge: "bg-red-500/15 text-red-700 dark:text-red-400",
    dot: "bg-red-500",
  },
  todo: {
    label: "To do",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  skipped: {
    label: "Skipped",
    badge: "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50",
    dot: "bg-black/25 dark:bg-white/25",
  },
};

// Encode a step's current owner as a <select> value, and decode a chosen value back
// to { ownerKind, ownerRepId }. "ai" → AI, "unassigned" → a rep step with no rep,
// otherwise a rep id (kind is sales_head if that rep is a sales head).
function ownerValue(step: FollowUpStepView): string {
  if (step.ownerKind === "ai") return "ai";
  return step.ownerRepId ?? "unassigned";
}

export function FollowUpRoadmap({
  leadId,
  steps,
  reps,
  summary,
  canEdit,
}: {
  leadId: string;
  steps: FollowUpStepView[];
  reps: Rep[];
  summary: string;
  canEdit: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Add-step form state.
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState("custom");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState("unassigned");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong");
      else after?.();
    });
  }

  function decodeOwner(value: string): { ownerKind: string; ownerRepId: string | null } {
    if (value === "ai") return { ownerKind: "ai", ownerRepId: null };
    if (value === "unassigned") return { ownerKind: "rep", ownerRepId: null };
    const rep = reps.find((r) => r.id === value);
    return { ownerKind: rep?.salesHead ? "sales_head" : "rep", ownerRepId: value };
  }

  function submitAdd() {
    const { ownerKind, ownerRepId } = decodeOwner(owner);
    run(
      () => addFollowUpStep({ leadId, title, channel, dueAt: due || null, ownerKind, ownerRepId }),
      () => {
        setTitle("");
        setChannel("custom");
        setDue("");
        setOwner("unassigned");
        setAdding(false);
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-black/50 dark:text-white/50">{summary}</span>
        {canEdit && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            {adding ? "Cancel" : "+ Add step"}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {adding && canEdit && (
        <div className="space-y-2 rounded border border-black/10 p-3 dark:border-white/15">
          <div className="flex flex-wrap gap-2">
            <input
              className="min-w-[16rem] flex-1 rounded border border-black/15 bg-cara-surface px-3 py-2 text-sm text-cara-ink dark:border-white/20"
              placeholder="Step title (e.g. Counsellor follow-up call)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <select
              className="rounded border border-black/15 bg-cara-surface px-2 py-2 text-sm text-cara-ink dark:border-white/20"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              <option value="custom">Custom</option>
              <option value="call">Call</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="ai_call">AI call</option>
              <option value="quote">Quote</option>
            </select>
            <input
              type="date"
              className="rounded border border-black/15 bg-cara-surface px-2 py-2 text-sm text-cara-ink dark:border-white/20"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <select
              className="rounded border border-black/15 bg-cara-surface px-2 py-2 text-sm text-cara-ink dark:border-white/20"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="unassigned">Unassigned</option>
              <option value="ai">AI</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.salesHead ? " (Sales head)" : ""}
                </option>
              ))}
            </select>
          </div>
          <button
            disabled={pending || !title.trim()}
            onClick={submitAdd}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          >
            Add step
          </button>
        </div>
      )}

      {steps.length === 0 ? (
        <p className="text-sm text-black/50 dark:text-white/50">
          No follow-up steps yet{canEdit ? " — add the first step above." : "."}
        </p>
      ) : (
        <ol className="space-y-2">
          {steps.map((s, i) => {
            const v = VISUAL[s.visual] ?? VISUAL.todo;
            const isOpen = s.status === "pending";
            return (
              <li
                key={s.id}
                className="relative flex gap-3 rounded border border-black/10 p-3 dark:border-white/15"
              >
                {/* Status rail */}
                <div className="flex flex-col items-center">
                  <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${v.dot}`} />
                  {i < steps.length - 1 && <span className="mt-1 w-px flex-1 bg-black/10 dark:bg-white/15" />}
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span aria-hidden>{CHANNEL_ICON[s.channel] ?? "•"}</span>
                    <span className="font-medium">{s.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${v.badge}`}>{v.label}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-black/55 dark:text-white/55">
                    <span>
                      {s.ownerKind === "ai" ? "🤖 AI" : `👤 ${s.ownerName}`}
                    </span>
                    {s.dueAt && (
                      <span className={s.visual === "missed" ? "text-red-600 dark:text-red-400" : ""}>
                        Due {formatIst(s.dueAt)}
                      </span>
                    )}
                    {s.status === "done" && s.completedAt && <span>✓ {formatIst(s.completedAt)}</span>}
                    {s.note && <span className="italic">“{s.note}”</span>}
                  </div>

                  {canEdit && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {isOpen ? (
                        <>
                          <button
                            disabled={pending}
                            onClick={() => run(() => completeFollowUpStep({ stepId: s.id, leadId }))}
                            className="rounded border border-green-600/40 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-600/10 disabled:opacity-50 dark:text-green-400"
                          >
                            ✓ Mark done
                          </button>
                          <button
                            disabled={pending}
                            onClick={() => run(() => skipFollowUpStep({ stepId: s.id, leadId }))}
                            className="rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
                          >
                            Skip
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={pending}
                          onClick={() => run(() => reopenFollowUpStep({ stepId: s.id, leadId }))}
                          className="rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
                        >
                          Reopen
                        </button>
                      )}

                      <select
                        aria-label="Accountable owner"
                        disabled={pending}
                        value={ownerValue(s)}
                        onChange={(e) => {
                          const { ownerKind, ownerRepId } = decodeOwner(e.target.value);
                          run(() => reassignFollowUpStep({ stepId: s.id, leadId, ownerKind, ownerRepId }));
                        }}
                        className="rounded border border-black/15 bg-cara-surface px-2 py-1 text-xs text-cara-ink disabled:opacity-50 dark:border-white/20"
                      >
                        <option value="unassigned">Unassigned</option>
                        <option value="ai">AI</option>
                        {reps.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                            {r.salesHead ? " (Sales head)" : ""}
                          </option>
                        ))}
                      </select>

                      <button
                        disabled={pending}
                        onClick={() => run(() => deleteFollowUpStep({ stepId: s.id, leadId }))}
                        title="Remove step"
                        className="rounded px-2 py-1 text-xs text-black/40 hover:text-red-600 disabled:opacity-50 dark:text-white/40 dark:hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
