"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  sendLeadWhatsApp,
  listWhatsAppTemplates,
  sendLeadWhatsAppTemplate,
} from "@/app/(dashboard)/leads/actions";
import type { WhatsAppTemplate } from "@/lib/whatsappTemplates";
import {
  suggestTemplateParams,
  previewTemplate,
  SOURCE_LABELS,
  type LeadTemplateContext,
  type ParamSource,
} from "@/lib/templateFill";
import { formatIst } from "@/lib/datetime";

export type ChatMessage = {
  id: string;
  direction: string; // inbound | outbound
  type: string;
  body: string | null;
  mediaId: string | null;
  templateName: string | null;
  status: string | null;
  sentBy: string | null;
  automated: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO — the live stream's cursor
};

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function senderLabel(m: ChatMessage): string {
  if (m.direction === "inbound") return "Patient";
  if (m.automated) return "Cara (automated)";
  return m.sentBy ?? "Agent";
}

/// Merge streamed rows into the server-rendered thread: newest version of each id
/// wins (a status tick rewrites an existing bubble), new ids are appended, and the
/// result stays in send order.
function mergeMessages(base: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return base;
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const m of incoming) {
    const prev = byId.get(m.id);
    if (!prev || m.updatedAt > prev.updatedAt) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function latestCursor(messages: ChatMessage[]): string | null {
  let max: string | null = null;
  for (const m of messages) if (!max || m.updatedAt > max) max = m.updatedAt;
  return max;
}

// One continuous WhatsApp thread (automated + manual) for a lead, plus a composer
// that only lets an agent send free-form text inside the 24h service window. The
// thread is live: an SSE stream pushes inbound replies and delivery receipts in
// as they happen, so two agents (or an agent and the chatbot) see the same chat.
export function WhatsAppChat({
  leadId,
  windowOpen,
  optedOut,
  messages,
  leadContext,
  variant = "card",
}: {
  leadId: string;
  windowOpen: boolean;
  optedOut: boolean;
  messages: ChatMessage[];
  leadContext: LeadTemplateContext;
  /// "card" — a bounded panel on the lead page, sized to its content.
  /// "fill" — takes the height it's given, for the WhatsApp inbox's chat pane.
  variant?: "card" | "fill";
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Deltas the stream has pushed since the page rendered, laid over the
  // server-rendered thread — so a router.refresh() and the live stream can't
  // fight over the same bubble.
  const [streamed, setStreamed] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState(false);
  const items = useMemo(() => mergeMessages(messages, streamed), [messages, streamed]);

  // ── Live thread ──────────────────────────────────────────────────
  // Reconnects are handled by EventSource itself (it replays Last-Event-ID);
  // we only re-open when the lead changes.
  useEffect(() => {
    const since = latestCursor(messages) ?? new Date(Date.now() - SERVICE_WINDOW_MS).toISOString();
    const source = new EventSource(
      `/api/leads/${leadId}/messages/stream?since=${encodeURIComponent(since)}`,
    );
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.addEventListener("messages", (ev) => {
      try {
        const incoming = JSON.parse((ev as MessageEvent).data) as ChatMessage[];
        setStreamed((current) => mergeMessages(current, incoming));
      } catch {
        /* ignore a malformed frame — the next poll resends it */
      }
    });
    return () => {
      source.close();
      setLive(false);
    };
    // `messages` is only the starting cursor; re-running on every refresh would
    // needlessly tear the connection down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // ── Auto-scroll ──────────────────────────────────────────────────
  // Follow the conversation, but don't yank an agent who scrolled up to read.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // ── 24h window ───────────────────────────────────────────────────
  // Derived from the thread, so a patient's reply swaps the template picker for
  // the composer the moment it lands — and the window closing 24h later swaps it
  // back. The minute tick is only there to re-check the clock.
  // `now` is read from a timer, never during render (render must stay pure); it
  // is null until the first tick lands, and the server's verdict holds till then.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const t = setInterval(update, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  const isWindowOpen = useMemo(() => {
    if (now === null) return windowOpen;
    let lastInbound = 0;
    for (const m of items) {
      if (m.direction !== "inbound") continue;
      const t = new Date(m.createdAt).getTime();
      if (t > lastInbound) lastInbound = t;
    }
    // No inbound at all in the thread → trust the server's verdict.
    if (lastInbound === 0) return windowOpen;
    return now - lastInbound < SERVICE_WINDOW_MS;
  }, [items, windowOpen, now]);

  function send() {
    const body = text.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      const res = await sendLeadWhatsApp(leadId, body);
      if (res.ok) {
        setText("");
        pinnedRef.current = true;
        router.refresh();
      } else {
        setError(res.error ?? "Failed to send");
      }
    });
  }

  return (
    <div
      className={
        variant === "fill"
          ? "flex h-full min-h-0 flex-col"
          : "rounded border border-black/10 dark:border-white/15"
      }
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`space-y-2 overflow-y-auto p-4 ${
          variant === "fill" ? "min-h-0 flex-1" : "max-h-96"
        }`}
      >
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-black/50 dark:text-white/50">
            No WhatsApp messages yet.
          </p>
        ) : (
          items.map((m) => {
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
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-black/40 dark:text-white/40">
                    <span>{senderLabel(m)}</span>
                    {m.templateName ? (
                      <span
                        title={`Sent using the approved template "${m.templateName}"`}
                        className="rounded bg-black/10 px-1 py-px normal-case tracking-normal dark:bg-white/15"
                      >
                        template · {m.templateName}
                      </span>
                    ) : null}
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
                  ) : m.templateName && m.body === `[template] ${m.templateName}` ? (
                    // A template sent before we logged its text, whose template is
                    // no longer approved (scripts/backfillTemplateBodies.ts repairs
                    // the rest). Say so plainly rather than showing the marker.
                    <div className="italic text-black/50 dark:text-white/50">
                      Template message — text not recorded
                    </div>
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

      <div className="shrink-0 border-t border-black/10 p-3 dark:border-white/15">
        {optedOut ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            🚫 This lead opted out — messaging is disabled.
          </p>
        ) : !isWindowOpen ? (
          <TemplatePicker leadId={leadId} leadContext={leadContext} />
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
        <p className="mt-2 text-[11px] text-black/35 dark:text-white/35">
          {live ? "● Live — new replies appear here automatically" : "○ Reconnecting to live chat…"}
        </p>
      </div>
    </div>
  );
}

// Re-open a closed 24h window by sending an APPROVED template. Templates are
// fetched lazily (only when the agent opens the picker). Body variables are
// pre-filled from the lead — the patient's name, treatment, clinic, rep — and
// the preview shows the exact message that will land on their phone.
function TemplatePicker({
  leadId,
  leadContext,
}: {
  leadId: string;
  leadContext: LeadTemplateContext;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WhatsAppTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [sources, setSources] = useState<ParamSource[]>([]);
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
    if (!t) {
      setParams([]);
      setSources([]);
      return;
    }
    const filled = suggestTemplateParams(t.bodyText, leadContext, t.paramCount);
    setParams(filled.map((f) => f.value));
    setSources(filled.map((f) => f.source));
  }

  function setParam(i: number, value: string) {
    setParams((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  }

  const missing = params.some((p) => !p.trim());

  function sendTemplate() {
    if (!current) return;
    setError(null);
    startTransition(async () => {
      const res = await sendLeadWhatsAppTemplate(leadId, current.name, current.language, params);
      if (res.ok) {
        setOpen(false);
        setSelected("");
        setParams([]);
        setSources([]);
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
              <div className="rounded bg-black/5 px-3 py-2 dark:bg-white/10">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-black/40 dark:text-white/40">
                  Message preview
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {previewTemplate(current.bodyText, params)}
                </p>
              </div>
              {params.map((p, i) => {
                const label = SOURCE_LABELS[sources[i] ?? "manual"];
                return (
                  <label key={i} className="block space-y-0.5">
                    <span className="text-[11px] text-black/45 dark:text-white/45">
                      {`Variable {{${i + 1}}}`}
                      {label ? ` — auto-filled with the ${label}` : ""}
                    </span>
                    <input
                      value={p}
                      placeholder={`Variable {{${i + 1}}}`}
                      onChange={(e) => setParam(i, e.target.value)}
                      className="w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20"
                    />
                  </label>
                );
              })}
              {missing && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Fill every variable — WhatsApp rejects a template with an empty one.
                </p>
              )}
            </>
          )}
          <div className="flex gap-2">
            <button
              onClick={sendTemplate}
              disabled={pending || !current || missing}
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
