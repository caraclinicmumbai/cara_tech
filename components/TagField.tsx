"use client";

import { useState, useTransition } from "react";
import { setLeadTag } from "@/app/(dashboard)/leads/actions";

// Inline editable tag ("what the lead asked for"). AI fills it from the call;
// staff can edit here. Saves on blur or Enter, only when the value changed.
export function TagField({
  leadId,
  tag,
  placeholder = "—",
  className = "",
}: {
  leadId: string;
  tag: string | null;
  placeholder?: string;
  className?: string;
}) {
  const initial = tag ?? "";
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, startTransition] = useTransition();

  function commit() {
    const next = value.trim();
    if (next === saved) return; // nothing changed
    setSaved(next);
    startTransition(() => {
      void setLeadTag(leadId, next);
    });
  }

  return (
    <input
      aria-label="Lead tag"
      value={value}
      disabled={pending}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={`w-full max-w-[14rem] rounded border border-transparent bg-transparent px-2 py-1 text-xs hover:border-black/15 focus:border-black/30 focus:outline-none disabled:opacity-50 dark:hover:border-white/20 dark:focus:border-white/40 ${className}`}
    />
  );
}
