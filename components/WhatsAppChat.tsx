"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendLeadWhatsApp } from "@/app/(dashboard)/leads/actions";

export type ChatMessage = {
  id: string;
  direction: string; // inbound | outbound
  type: string;
  body: string | null;
  status: string | null;
  sentBy: string | null;
  automated: boolean;
  createdAt: string; // ISO
};

function senderLabel(m: ChatMessage): string {
  if (m.direction === "inbound") return "Patient";
  if (m.automated) return "Cara (automated)";
  return m.sentBy ?? "Agent";
}

// One continuous WhatsApp thread (automated + manual) for a lead, plus a composer
// that only lets an agent send free-form text inside the 24h service window.
export function WhatsAppChat({
  leadId,
  windowOpen,
  optedOut,
  messages,
}: {
  leadId: string;
  windowOpen: boolean;
  optedOut: boolean;
  messages: ChatMessage[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const canSend = windowOpen && !optedOut;

  function send() {
    const body = text.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      const res = await sendLeadWhatsApp(leadId, body);
      if (res.ok) {
        setText("");
        router.refresh();
      } else {
        setError(res.error ?? "Failed to send");
      }
    });
  }

  return (
    <div className="rounded border border-black/10 dark:border-white/15">
      <div className="max-h-96 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="py-6 text-center text-sm text-black/50 dark:text-white/50">
            No WhatsApp messages yet.
          </p>
        ) : (
          messages.map((m) => {
            const inbound = m.direction === "inbound";
            return (
              <div key={m.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                    inbound
                      ? "bg-black/5 dark:bg-white/10"
                      : "bg-green-600/15 dark:bg-green-500/15"
                  }`}
                >
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-black/40 dark:text-white/40">
                    {senderLabel(m)}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.body ?? `[${m.type}]`}</div>
                  <div
                    suppressHydrationWarning
                    className="mt-0.5 text-right text-[10px] text-black/40 dark:text-white/40"
                  >
                    {new Date(m.createdAt).toLocaleString()}
                    {!inbound && m.status ? ` · ${m.status}` : ""}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-black/10 p-3 dark:border-white/15">
        {optedOut ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            🚫 This lead opted out — messaging is disabled.
          </p>
        ) : !windowOpen ? (
          <p className="text-sm text-black/50 dark:text-white/50">
            ⏳ Outside the 24h reply window. Send an approved template to re-open the chat (coming next).
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <textarea
                value={text}
                disabled={pending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                }}
                placeholder="Type a reply…  (⌘/Ctrl+Enter to send)"
                rows={2}
                className="flex-1 resize-none rounded border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
              />
              <button
                onClick={send}
                disabled={pending || !text.trim()}
                className="self-end rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
              >
                {pending ? "Sending…" : "Send"}
              </button>
            </div>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
