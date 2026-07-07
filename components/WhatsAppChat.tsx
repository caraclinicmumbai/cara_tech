"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  sendLeadWhatsApp,
  listWhatsAppTemplates,
  sendLeadWhatsAppTemplate,
} from "@/app/(dashboard)/leads/actions";
import type { WhatsAppTemplate } from "@/lib/whatsappTemplates";
import { formatIst } from "@/lib/datetime";

export type ChatMessage = {
  id: string;
  direction: string; // inbound | outbound
  type: string;
  body: string | null;
  mediaId: string | null;
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
                  {m.mediaId && m.type === "image" ? (
                    <a href={`/api/whatsapp/media/${m.mediaId}`} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/whatsapp/media/${m.mediaId}`}
                        alt={m.body ?? "image"}
                        className="max-h-48 rounded"
                      />
                      {m.body && m.body !== "[image]" ? (
                        <div className="mt-1 whitespace-pre-wrap break-words">{m.body}</div>
                      ) : null}
                    </a>
                  ) : m.mediaId ? (
                    <a
                      href={`/api/whatsapp/media/${m.mediaId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      📎 {m.body ?? `[${m.type}]`}
                    </a>
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{m.body ?? `[${m.type}]`}</div>
                  )}
                  <div
                    suppressHydrationWarning
                    className="mt-0.5 text-right text-[10px] text-black/40 dark:text-white/40"
                  >
                    {formatIst(m.createdAt)}
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
          <TemplatePicker leadId={leadId} />
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

// Re-open a closed 24h window by sending an APPROVED template. Templates are
// fetched lazily (only when the agent opens the picker); body variables get a
// text input each.
function TemplatePicker({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const current = templates?.find((t) => t.name === selected);

  async function openPicker() {
    setOpen(true);
    if (templates) return;
    setLoading(true);
    try {
      setTemplates(await listWhatsAppTemplates());
    } catch {
      setTemplates([]);
      setError("Couldn't load templates");
    } finally {
      setLoading(false);
    }
  }

  function pick(name: string) {
    setSelected(name);
    const t = templates?.find((x) => x.name === name);
    setParams(Array(t?.paramCount ?? 0).fill(""));
  }

  function sendTemplate() {
    if (!current) return;
    setError(null);
    startTransition(async () => {
      const res = await sendLeadWhatsAppTemplate(leadId, current.name, current.language, params);
      if (res.ok) {
        setOpen(false);
        setSelected("");
        setParams([]);
        router.refresh();
      } else {
        setError(res.error ?? "Failed to send template");
      }
    });
  }

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-black/50 dark:text-white/50">
          ⏳ Outside the 24h reply window — send an approved template to re-open the chat.
        </p>
        <button
          onClick={openPicker}
          className="shrink-0 rounded border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
        >
          Send template
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {loading ? (
        <p className="text-sm text-black/50 dark:text-white/50">Loading templates…</p>
      ) : templates && templates.length > 0 ? (
        <>
          <select
            value={selected}
            onChange={(e) => pick(e.target.value)}
            className="w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
          >
            <option value="">Select a template…</option>
            {templates.map((t) => (
              <option key={`${t.name}:${t.language}`} value={t.name}>
                {t.name} ({t.language})
              </option>
            ))}
          </select>
          {current && (
            <>
              <p className="rounded bg-black/5 px-2 py-1 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
                {current.bodyText}
              </p>
              {params.map((p, i) => (
                <input
                  key={i}
                  value={p}
                  placeholder={`Variable {{${i + 1}}}`}
                  onChange={(e) => {
                    const next = [...params];
                    next[i] = e.target.value;
                    setParams(next);
                  }}
                  className="w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
                />
              ))}
            </>
          )}
          <div className="flex gap-2">
            <button
              onClick={sendTemplate}
              disabled={pending || !current}
              className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {pending ? "Sending…" : "Send template"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded border border-black/15 px-3 py-2 text-sm dark:border-white/20"
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-black/50 dark:text-white/50">
          No approved templates found — set WHATSAPP_WABA_ID and get a template approved in Meta.
          <button onClick={() => setOpen(false)} className="ml-2 underline">
            Close
          </button>
        </p>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
