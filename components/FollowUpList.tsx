"use client";

// The lead's follow-ups beyond the date field (§follow-up). Every lead starts with one
// follow-up; this is the option to schedule more, and to mark each one done or remove it.
// Closing the next one makes the following one the date the leads table shows.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addLeadFollowUp, closeLeadFollowUp } from "@/app/(dashboard)/leads/followUpActions";
import { TimeSelects, fromParts, toParts, type Parts } from "@/components/FollowUpField";

type Item = { id: string; when: string; title: string; overdue: boolean };

export function FollowUpList({ leadId, next, later }: { leadId: string; next: Item | null; later: Item[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [parts, setParts] = useState<Parts>(() => toParts(""));
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string; info?: string }>, onOk?: () => void) {
    setMsg(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return setMsg({ kind: "err", text: r.error ?? "Something went wrong" });
      setMsg(r.info ? { kind: "ok", text: r.info } : null);
      onOk?.();
      router.refresh();
    });
  }

  const close = (stepId: string, status: "done" | "skipped") => run(() => closeLeadFollowUp({ leadId, stepId, status }));

  function add() {
    run(
      () => addLeadFollowUp({ leadId, dueAt: fromParts(parts), title }),
      () => {
        setAdding(false);
        setParts(toParts(""));
        setTitle("");
      },
    );
  }

  return (
    <div className="space-y-1.5 text-[12.5px]">
      {next && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="cara-btn cara-control-compact" disabled={pending} onClick={() => close(next.id, "done")}>
            Mark done
          </button>
          {later.length > 0 && <span className="text-cara-faint">then the next one below becomes the follow-up date</span>}
        </div>
      )}

      {later.length > 0 && (
        <ul className="space-y-1">
          {later.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2">
              <span className={f.overdue ? "txt-bad" : ""}>
                {f.when} · {f.title}
                {f.overdue ? " (overdue)" : ""}
              </span>
              <button type="button" className="tone-link" disabled={pending} onClick={() => close(f.id, "done")}>
                Done
              </button>
              <button type="button" className="txt-bad hover:underline" disabled={pending} onClick={() => close(f.id, "skipped")}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="date"
            aria-label="New follow-up date"
            value={parts.date}
            disabled={pending}
            onChange={(e) => setParts({ ...parts, date: e.target.value })}
            className="cara-input cara-control-compact"
          />
          <TimeSelects parts={parts} disabled={pending} onChange={(p) => setParts({ ...parts, ...p })} />
          <span className="text-[11px] text-cara-faint">IST</span>
          <input
            className="cara-input cara-control-compact w-48!"
            placeholder="What for (optional)"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="button" className="cara-btn cara-btn-primary cara-control-compact" disabled={pending || !parts.date} onClick={add}>
            Add
          </button>
          <button type="button" className="cara-btn cara-control-compact" disabled={pending} onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="tone-link" onClick={() => setAdding(true)}>
          + Add follow-up
        </button>
      )}

      {msg && <div className={msg.kind === "ok" ? "txt-good" : "txt-bad"}>{msg.text}</div>}
    </div>
  );
}
