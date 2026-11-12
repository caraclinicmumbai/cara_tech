"use client";

import { useState, useTransition } from "react";
import { setLeadRemark } from "@/app/(dashboard)/leads/actions";

// Inline remark on the leads dashboard ("where this lead stands"). Shows the lead's
// newest note; typing a new one and pressing Enter (or leaving the box) adds it to the
// lead's Notes & comments, where the whole history lives (lib/leadRemarks.ts).
// Clearing the box doesn't delete anything — it just puts the current remark back.
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
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A note added on the lead page (or by a colleague) arrives as a new prop on refresh.
  const [prop, setProp] = useState(initial);
  if (initial !== prop) {
    setProp(initial);
    setSaved(initial);
    setValue(initial);
  }

  function commit() {
    const next = value.trim();
    if (!next) {
      setValue(saved);
      return;
    }
    if (next === saved) return; // nothing changed
    const previous = saved;
    setSaved(next);
    setError(null);
    startTransition(async () => {
      const res = await setLeadRemark(leadId, next).catch(() => ({ ok: false, error: "Couldn't save" }));
      if (!res.ok) {
        setSaved(previous);
        setValue(previous);
        setError(res.error ?? "Couldn't save");
      }
    });
  }

  return (
    <input
      aria-label="Lead remark"
      title={error ?? (value ? `${value}\n\nType a new remark to add it to the lead's notes` : "Add a remark")}
      value={value}
      disabled={pending}
      placeholder={placeholder}
      maxLength={500}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(saved);
          e.currentTarget.blur();
        }
      }}
      className={`w-full min-w-48 max-w-[18rem] rounded border bg-transparent px-2 py-1 text-xs hover:border-black/15 focus:border-black/30 focus:outline-none disabled:opacity-50 dark:hover:border-white/20 dark:focus:border-white/40 ${error ? "border-(--state-danger-bd)" : "border-transparent"} ${className}`}
    />
  );
}
