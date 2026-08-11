"use client";

// WhatsApp template builder (§template builder). Compose a template — name,
// category, language, text header, body with {{n}} variables, footer, and
// quick-reply / URL / phone buttons — and submit it to Meta for approval, with a
// live WhatsApp-style preview. Media headers (image/video/document) are a follow-up
// (they need a sample-media upload).
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTemplateAction } from "@/app/(dashboard)/templates/actions";
import type { TemplateButton } from "@/lib/whatsappTemplates";

const LANGUAGES = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "mr", label: "Marathi" },
];

const input =
  "w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

type BtnDraft = { type: TemplateButton["type"]; text: string; url?: string; phone_number?: string };

function varCountOf(body: string): number {
  const nums = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) nums.add(Number(m[1]));
  return nums.size;
}

export function TemplateBuilder() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [category, setCategory] = useState<"MARKETING" | "UTILITY">("UTILITY");
  const [headerType, setHeaderType] = useState<"NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT">("NONE");
  const [header, setHeader] = useState("");
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [buttons, setButtons] = useState<BtnDraft[]>([]);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const varCount = useMemo(() => varCountOf(body), [body]);

  const preview = useMemo(() => {
    let p = body;
    for (let i = 0; i < varCount; i++) p = p.replaceAll(`{{${i + 1}}}`, examples[i]?.trim() || `{{${i + 1}}}`);
    return p;
  }, [body, examples, varCount]);

  const addVariable = () => setBody((b) => `${b}{{${varCountOf(b) + 1}}}`);
  const addButton = (type: BtnDraft["type"]) =>
    setButtons((bs) => (bs.length >= 10 ? bs : [...bs, { type, text: "" }]));
  const updateButton = (i: number, patch: Partial<BtnDraft>) =>
    setButtons((bs) => bs.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const removeButton = (i: number) => setButtons((bs) => bs.filter((_, idx) => idx !== i));

  const isMediaHeader = headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT";

  function submit() {
    setResult(null);
    startTransition(async () => {
      // Media headers: upload the sample file first to get a header handle.
      let headerHandle: string | undefined;
      if (isMediaHeader) {
        if (!headerFile) { setResult({ ok: false, msg: "Pick a sample file for the media header" }); return; }
        const fd = new FormData();
        fd.append("file", headerFile);
        const up = await fetch("/api/templates/upload-sample", { method: "POST", body: fd });
        const j = await up.json().catch(() => ({}));
        if (!up.ok) { setResult({ ok: false, msg: j.error ?? "Sample upload failed" }); return; }
        headerHandle = j.handle;
      }

      const cleanButtons: TemplateButton[] = buttons
        .filter((b) => b.text.trim())
        .map((b) =>
          b.type === "URL"
            ? { type: "URL", text: b.text, url: b.url ?? "" }
            : b.type === "PHONE_NUMBER"
              ? { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone_number ?? "" }
              : { type: "QUICK_REPLY", text: b.text },
        );
      const res = await createTemplateAction({
        name,
        language,
        category,
        header: headerType === "TEXT" ? header || undefined : undefined,
        headerFormat: headerType === "NONE" ? undefined : headerType,
        headerHandle,
        body,
        bodyExamples: examples.slice(0, varCount),
        footer: footer || undefined,
        buttons: cleanButtons.length ? cleanButtons : undefined,
      });
      if (res.ok) {
        setResult({ ok: true, msg: `Submitted for review — status ${res.status}.` });
        setName(""); setHeader(""); setBody(""); setFooter(""); setExamples([]); setButtons([]);
        setHeaderType("NONE"); setHeaderFile(null);
        router.refresh();
      } else {
        setResult({ ok: false, msg: res.error });
      }
    });
  }

  const btnLabel: Record<BtnDraft["type"], string> = {
    QUICK_REPLY: "Quick reply",
    URL: "Visit URL",
    PHONE_NUMBER: "Call",
  };

  return (
    <div className="grid gap-4 rounded border border-black/10 p-4 dark:border-white/15 md:grid-cols-[1fr_320px]">
      {/* ── Form ── */}
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-black/60 dark:text-white/60">Name (lowercase, underscores)</label>
          <input className={input} value={name} placeholder="appointment_reminder"
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-black/60 dark:text-white/60">Language</label>
            <select className={input} value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-black/60 dark:text-white/60">Category</label>
            <select className={input} value={category} onChange={(e) => setCategory(e.target.value as "MARKETING" | "UTILITY")}>
              <option value="UTILITY">Utility</option>
              <option value="MARKETING">Marketing</option>
            </select>
          </div>
        </div>

        {/* Header */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-black/60 dark:text-white/60">Header (optional)</label>
            <select className={input} value={headerType}
              onChange={(e) => { setHeaderType(e.target.value as typeof headerType); setHeaderFile(null); }}>
              <option value="NONE">None</option>
              <option value="TEXT">Text</option>
              <option value="IMAGE">Image</option>
              <option value="VIDEO">Video</option>
              <option value="DOCUMENT">Document</option>
            </select>
          </div>
          {headerType === "TEXT" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-black/60 dark:text-white/60">Header text</label>
              <input className={input} value={header} placeholder="Cara Clinic" maxLength={60} onChange={(e) => setHeader(e.target.value)} />
            </div>
          )}
          {isMediaHeader && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-black/60 dark:text-white/60">Sample {headerType.toLowerCase()}</label>
              <input
                type="file"
                className="w-full text-xs"
                accept={headerType === "IMAGE" ? "image/*" : headerType === "VIDEO" ? "video/*" : ".pdf,application/pdf"}
                onChange={(e) => setHeaderFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}
        </div>
        {isMediaHeader && (
          <p className="text-[11px] text-black/40 dark:text-white/40">
            Meta needs a sample {headerType.toLowerCase()} to approve the template. Each message you send later swaps in the real file.
          </p>
        )}

        {/* Body */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-black/60 dark:text-white/60">Body</label>
            <button type="button" onClick={addVariable} className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-500/30 dark:text-amber-300">
              + Add variable
            </button>
          </div>
          <textarea className={`${input} resize-none`} rows={4} value={body} maxLength={1024}
            placeholder={"Hi {{1}}, your consultation at Cara Clinic is on {{2}}. Reply YES to confirm."}
            onChange={(e) => setBody(e.target.value)} />
          <div className="text-right text-[11px] text-black/40 dark:text-white/40">{body.length}/1024</div>
        </div>

        {varCount > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-black/60 dark:text-white/60">Example values (required by Meta for review)</p>
            {Array.from({ length: varCount }).map((_, i) => (
              <input key={i} className={input} value={examples[i] ?? ""} placeholder={`Example for {{${i + 1}}}`}
                onChange={(e) => { const next = [...examples]; next[i] = e.target.value; setExamples(next); }} />
            ))}
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs font-medium text-black/60 dark:text-white/60">Footer (optional)</label>
          <input className={input} value={footer} placeholder="Cara Clinic, Mumbai" maxLength={60} onChange={(e) => setFooter(e.target.value)} />
        </div>

        {/* Buttons */}
        <div className="space-y-2 rounded border border-black/10 p-3 dark:border-white/15">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-black/60 dark:text-white/60">Buttons (optional)</span>
            <button type="button" onClick={() => addButton("QUICK_REPLY")} className="rounded bg-black/5 px-2 py-1 text-[11px] hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15">+ Quick Reply</button>
            <button type="button" onClick={() => addButton("URL")} className="rounded bg-black/5 px-2 py-1 text-[11px] hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15">+ URL</button>
            <button type="button" onClick={() => addButton("PHONE_NUMBER")} className="rounded bg-black/5 px-2 py-1 text-[11px] hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15">+ Phone</button>
          </div>
          {buttons.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-[11px] text-black/50 dark:text-white/50">{btnLabel[b.type]}</span>
              <input className={`${input} flex-1`} placeholder="Button text" maxLength={25} value={b.text} onChange={(e) => updateButton(i, { text: e.target.value })} />
              {b.type === "URL" && (
                <input className={`${input} flex-1`} placeholder="https://…" value={b.url ?? ""} onChange={(e) => updateButton(i, { url: e.target.value })} />
              )}
              {b.type === "PHONE_NUMBER" && (
                <input className={`${input} flex-1`} placeholder="+91…" value={b.phone_number ?? ""} onChange={(e) => updateButton(i, { phone_number: e.target.value })} />
              )}
              <button type="button" onClick={() => removeButton(i)} className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-600 hover:bg-red-500/25 dark:text-red-400">✕</button>
            </div>
          ))}
        </div>

        <button onClick={submit} disabled={pending || !name || !body}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
          {pending ? "Submitting…" : "Submit for approval"}
        </button>
        <p className="text-[11px] text-black/40 dark:text-white/40">Submitted templates can&apos;t be edited — you&apos;d create a new one. Approval is usually a few hours.</p>

        {result && (
          <p className={`text-sm ${result.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
            {result.ok ? "✅ " : "⚠️ "}{result.msg}
          </p>
        )}
      </div>

      {/* ── WhatsApp-style preview ── */}
      <div className="space-y-2">
        <p className="text-center text-[11px] font-medium uppercase tracking-wide text-black/40 dark:text-white/40">Preview</p>
        <div className="rounded-2xl bg-[#e5ddd5] p-3 dark:bg-neutral-800">
          <div className="max-w-[85%] rounded-lg rounded-tl-none bg-white p-2.5 text-sm shadow dark:bg-neutral-900">
            {headerType === "TEXT" && header && <div className="mb-1 font-semibold">{header}</div>}
            {isMediaHeader && (
              <div className="mb-1.5 flex items-center justify-center rounded bg-black/5 py-4 text-xs text-black/50 dark:bg-white/10 dark:text-white/50">
                {headerType === "IMAGE" ? "🖼️ Image" : headerType === "VIDEO" ? "🎬 Video" : `📄 ${headerFile?.name ?? "Document"}`}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words text-black/90 dark:text-white/90">
              {preview || "Your message preview appears here…"}
            </div>
            {footer && <div className="mt-1.5 text-[11px] text-black/40 dark:text-white/40">{footer}</div>}
          </div>
          {buttons.filter((b) => b.text.trim()).length > 0 && (
            <div className="mt-1 max-w-[85%] space-y-0.5">
              {buttons.filter((b) => b.text.trim()).map((b, i) => (
                <div key={i} className="rounded-lg bg-white py-2 text-center text-sm font-medium text-[#00a5f4] shadow dark:bg-neutral-900">
                  {b.type === "URL" ? "🔗 " : b.type === "PHONE_NUMBER" ? "📞 " : "↩ "}{b.text}
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="text-[11px] text-black/40 dark:text-white/40">
          Utility = transactional (reminders, confirmations), approved faster. Marketing = promotional.
        </p>
      </div>
    </div>
  );
}
