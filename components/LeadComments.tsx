"use client";

// Staff notes / comments on a lead (§notes). A composer + a newest-first list. Anyone
// who works the lead can add a note; the author (or a manager) can delete one. Timestamps
// are pre-formatted on the server and passed as strings to avoid hydration mismatches.
import { useState, useTransition } from "react";
import { addLeadComment, deleteLeadComment } from "@/app/(dashboard)/leads/actions";

export type LeadCommentView = {
  id: string;
  authorName: string | null;
  body: string;
  createdAt: string; // pre-formatted IST label
  canDelete: boolean;
};

export function LeadComments({
  leadId,
  comments,
  canComment,
}: {
  leadId: string;
  comments: LeadCommentView[];
  canComment: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const text = value.trim();
    if (!text || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await addLeadComment(leadId, text);
      if (res.ok) setValue("");
      else setError(res.error ?? "Couldn't add the comment");
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const res = await deleteLeadComment(id);
      if (!res.ok) setError(res.error ?? "Couldn't delete the comment");
    });
  }

  return (
    <div className="space-y-4">
      {canComment && (
        <div className="space-y-2">
          <textarea
            value={value}
            disabled={pending}
            placeholder="Add a note or review for this lead…"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits (a plain Enter keeps a multi-line note editable).
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            className="w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm focus:border-black/40 focus:outline-none disabled:opacity-50 dark:border-white/20 dark:focus:border-white/40"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={pending || !value.trim()}
              className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              {pending ? "Saving…" : "Add comment"}
            </button>
            <span className="text-xs text-black/40 dark:text-white/40">⌘/Ctrl + Enter</span>
            {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
          </div>
        </div>
      )}

      {comments.length === 0 ? (
        <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
          No comments yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="rounded border border-black/10 p-3 dark:border-white/15">
              <div className="flex items-center gap-2 text-xs text-black/50 dark:text-white/50">
                <span className="font-medium text-black/70 dark:text-white/70">
                  {c.authorName ?? "Unknown"}
                </span>
                <span>·</span>
                <span>{c.createdAt}</span>
                {c.canDelete && (
                  <button
                    type="button"
                    onClick={() => remove(c.id)}
                    disabled={pending}
                    className="ml-auto text-black/40 hover:text-red-600 disabled:opacity-40 dark:text-white/40 dark:hover:text-red-400"
                  >
                    Delete
                  </button>
                )}
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-sm">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
