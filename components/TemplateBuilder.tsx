"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTemplateAction } from "@/app/(dashboard)/templates/actions";

const LANGUAGES = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "mr", label: "Marathi" },
];

const input =
  "w-full rounded border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

// Count distinct {{1}}, {{2}}… placeholders in the body.
function varCountOf(body: string): number {
  const nums = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) nums.add(Number(m[1]));
  return nums.size;
}

export function TemplateBuilder() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [category, setCategory] = useState<"MARKETING" | "UTILITY">("MARKETING");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const varCount = useMemo(() => varCountOf(body), [body]);

  // Preview: substitute examples (or {{n}}) into the body.
  const preview = useMemo(() => {
    let p = body;
    for (let i = 0; i < varCount; i++) {
      p = p.replaceAll(`{{${i + 1}}}`, examples[i]?.trim() || `{{${i + 1}}}`);
    }
    return p;
  }, [body, examples, varCount]);

  function submit() {
    setResult(null);
    startTransition(async () => {
      const res = await createTemplateAction({
        name,
        language,
        category,
        header: header || undefined,
        body,
        bodyExamples: examples.slice(0, varCount),
        footer: footer || undefined,
      });
      if (res.ok) {
        setResult({ ok: true, msg: `Submitted for review — status ${res.status}.` });
        setName("");
        setHeader("");
        setBody("");
        setFooter("");
        setExamples([]);
        router.refresh();
      } else {
        setResult({ ok: false, msg: res.error });
      }
    });
  }

  return (
    <div className="grid gap-4 rounded border border-black/10 p-4 dark:border-white/15 md:grid-cols-2">
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-black/60 dark:text-white/60">
            Name (lowercase, underscores)
          </label>
          <input
            className={input}
            value={name}
            placeholder="appointment_reminder"
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-black/60 dark:text-white/60">Language</label>
            <select className={input} value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-black/60 dark:text-white/60">Category</label>
            <select
              className={input}
              value={category}
              onChange={(e) => setCategory(e.target.value as "MARKETING" | "UTILITY")}
            >
              <option value="MARKETING">Marketing</option>
              <option value="UTILITY">Utility</option>
            </select>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-black/60 dark:text-white/60">
            Header (optional)
          </label>
          <input className={input} value={header} placeholder="Cara Clinic" onChange={(e) => setHeader(e.target.value)} />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-black/60 dark:text-white/60">
            Body — use {"{{1}}"}, {"{{2}}"} for variables
          </label>
          <textarea
            className={`${input} resize-none`}
            rows={4}
            value={body}
            placeholder={"Hi {{1}}, your consultation at Cara Clinic is on {{2}}. Reply YES to confirm."}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        {varCount > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-black/60 dark:text-white/60">
              Example values (required by Meta for review)
            </p>
            {Array.from({ length: varCount }).map((_, i) => (
              <input
                key={i}
                className={input}
                value={examples[i] ?? ""}
                placeholder={`Example for {{${i + 1}}}`}
                onChange={(e) => {
                  const next = [...examples];
                  next[i] = e.target.value;
                  setExamples(next);
                }}
              />
            ))}
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs font-medium text-black/60 dark:text-white/60">
            Footer (optional)
          </label>
          <input className={input} value={footer} placeholder="Cara Clinic, Mumbai" onChange={(e) => setFooter(e.target.value)} />
        </div>

        <button
          onClick={submit}
          disabled={pending || !name || !body}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {pending ? "Submitting…" : "Submit for review"}
        </button>

        {result && (
          <p className={`text-sm ${result.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
            {result.ok ? "✅ " : "⚠️ "}
            {result.msg}
          </p>
        )}
      </div>

      {/* Live preview */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-black/60 dark:text-white/60">Preview</p>
        <div className="rounded-lg border border-black/10 bg-green-600/5 p-3 text-sm dark:border-white/15">
          {header && <div className="mb-1 font-semibold">{header}</div>}
          <div className="whitespace-pre-wrap break-words">{preview || "Your message preview appears here…"}</div>
          {footer && <div className="mt-2 text-xs text-black/40 dark:text-white/40">{footer}</div>}
        </div>
        <p className="text-xs text-black/40 dark:text-white/40">
          Tip: Marketing templates can be promotional; Utility templates are for transactional
          messages (reminders, confirmations) and are approved faster.
        </p>
      </div>
    </div>
  );
}
