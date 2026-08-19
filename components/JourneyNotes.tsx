"use client";

// Journey-scoped notes (§post-sales). Deliberately NOT lead-scoped: a note about the
// hair transplant recovery has no business appearing on the same patient's PRP journey.
//
// `clinical` vs `admin` is a soft label, not a permission boundary — it exists so a
// consultant scanning the list can tell a medical observation from a logistics note.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatIst } from "@/lib/datetime";
import type { NoteView } from "@/lib/postSales/board";
import { addJourneyNote, deleteJourneyNote } from "@/app/(dashboard)/post-sales/actions";

export function JourneyNotes({
  journeyId,
  notes,
  canWrite,
  canDeleteAny,
}: {
  journeyId: string;
  notes: NoteView[];
  canWrite: boolean;
  /// Holders of `postsales.manage` can remove anyone's note; others only their own
  /// (which the server re-checks — this only decides whether to show the button).
  canDeleteAny: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("clinical");

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong");
      else {
        after?.();
        router.refresh();
      }
    });
  }

  return (
    <section className="cara-card space-y-3 p-4">
      <h2 className="cara-sec-hd">Journey notes</h2>

      {error && <div className="cara-callout cara-callout-danger">{error}</div>}

      {canWrite && (
        <div className="space-y-2">
          <textarea
            className="cara-textarea"
            rows={3}
            placeholder="Recovery observation, dressing change, what the patient reported…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <select className="cara-select" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="clinical">Clinical</option>
              <option value="admin">Admin / logistics</option>
            </select>
            <button
              type="button"
              className="cara-btn cara-btn-primary"
              disabled={pending || !body.trim()}
              onClick={() => run(() => addJourneyNote({ journeyId, body, kind }), () => setBody(""))}
            >
              {pending ? "Saving…" : "Add note"}
            </button>
          </div>
        </div>
      )}

      {notes.length === 0 ? (
        <p className="text-[13px] text-cara-faint">No notes on this journey yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg bg-cara-tint px-3 py-2 text-[13px]">
              <div className="flex items-start justify-between gap-2">
                <div className="text-[11px] text-cara-faint">
                  <span className="cara-badge mr-1">{n.kind === "admin" ? "Admin" : "Clinical"}</span>
                  {n.authorName} · {formatIst(n.createdAt)}
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-cara-faint hover:text-danger"
                    disabled={pending}
                    title={canDeleteAny ? "Delete note" : "Delete (only your own)"}
                    onClick={() => run(() => deleteJourneyNote({ journeyId, noteId: n.id }))}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div className="mt-1 whitespace-pre-wrap">{n.body}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
