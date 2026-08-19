"use client";

import { useState, useTransition } from "react";
import { setLeadRemark } from "@/app/(dashboard)/leads/actions";

// Inline editable one-line staff remark ("where this lead stands"). Saves on blur
// or Enter, only when the value changed — same contract as TagField.
export function RemarkField({
  leadId,
  remark,
  placeholder = "—",
  className = "",
}: {
  leadId: string;
  remark: string | null;
  placeholder?: string;
  className?: string;
}) {
  const initial = remark ?? "";
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, startTransition] = useTransition();

  function commit() {
    const next = value.trim();
    if (next === saved) return; // nothing changed
    setSaved(next);
    startTransition(() => {
      void setLeadRemark(leadId, next);
    });
  }

  return (
    <input
      aria-label="Lead remark"
      title={value || undefined}
      value={value}
      disabled={pending}
      placeholder={placeholder}
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className={`w-full min-w-[12rem] max-w-[18rem] rounded border border-transparent bg-transparent px-2 py-1 text-xs hover:border-black/15 focus:border-black/30 focus:outline-none disabled:opacity-50 dark:hover:border-white/20 dark:focus:border-white/40 ${className}`}
    />
  );
}
