"use client";

// The "/" menu in the WhatsApp composer (§messaging) — quick replies, like WhatsApp
// Business. Typing "/" at the start of a word lists the approved templates, narrowed as you
// type; picking one puts its text in the reply box, with the patient's details filled in,
// to read or edit before sending.
//
// This only exists inside the 24-hour window, where the reply is ordinary text. Outside it
// WhatsApp accepts only the approved template itself, which is what TemplatePicker sends.
import type { WhatsAppTemplate } from "@/lib/whatsappTemplates";

/// The "/word" being typed at the caret, if any. A slash inside a word or a link is not one.
export function slashTokenAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1].length, query: m[2] } : null;
}

const MAX_SHOWN = 8;

/// Templates matching the words typed after the slash, in the template's name or its text.
export function matchTemplates(templates: WhatsAppTemplate[], query: string): WhatsAppTemplate[] {
  const q = query.toLowerCase().replace(/[_-]/g, " ").trim();
  const hits = q
    ? templates.filter((t) => `${t.name.replace(/[_-]/g, " ")} ${t.bodyText}`.toLowerCase().includes(q))
    : templates;
  return hits.slice(0, MAX_SHOWN);
}

export function TemplateSlashMenu({
  templates,
  active,
  onPick,
}: {
  /// Null while the list is loading.
  templates: WhatsAppTemplate[] | null;
  active: number;
  onPick: (t: WhatsAppTemplate) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Message templates"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-72 w-full overflow-auto rounded border border-black/15 bg-background shadow-lg dark:border-white/20"
    >
      {templates === null ? (
        <p className="px-3 py-2 text-sm text-cara-muted">Loading templates…</p>
      ) : templates.length === 0 ? (
        <p className="px-3 py-2 text-sm text-cara-muted">No template matches.</p>
      ) : (
        templates.map((t, i) => (
          <button
            key={`${t.name}:${t.language}`}
            type="button"
            role="option"
            aria-selected={i === active}
            // mousedown, not click: a click would blur the box and lose the caret first.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(t);
            }}
            className={`block w-full px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/10 ${i === active ? "bg-black/5 dark:bg-white/10" : ""}`}
          >
            <span className="block text-sm font-medium">/{t.name} <span className="font-normal text-cara-muted">({t.language})</span></span>
            <span className="block truncate text-xs text-cara-muted">{t.bodyText}</span>
          </button>
        ))
      )}
    </div>
  );
}
