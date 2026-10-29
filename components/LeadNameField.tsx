"use client";

// The lead's name as the page heading, editable in place (§lead details). A caller from an
// unknown number arrives as "Caller 1234"; whoever answers needs to put the real name in
// while they're still on the phone, so the control sits on the name itself rather than in
// the "Edit details" form further down. Saves through the same audited `editLead` action,
// passing the other details through unchanged.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editLead } from "@/app/(dashboard)/leads/actions";

/// A placeholder name the clinic line gave an unknown caller (lib/inboundRouting.ts).
export function isPlaceholderName(name: string): boolean {
  return /^Caller (\d{4}|unknown)$/.test(name);
}

export function LeadNameField({
  leadId,
  name,
  phone,
  email,
  interest,
  canEdit,
}: {
  leadId: string;
  name: string;
  phone: string;
  email: string | null;
  interest: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const placeholder = isPlaceholderName(name);

  const cancel = () => {
    setValue(name);
    setEditing(false);
  };
  const save = () => {
    const next = value.trim();
    if (!next || next === name) return cancel();
    startTransition(async () => {
      const res = await editLead(leadId, { name: next, phone, email, interest });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else window.alert(res.error ?? "Could not save the name");
    });
  };

  if (editing) {
    return (
      <span className="flex items-center gap-2">
        <input
          autoFocus
          className="rounded border border-black/15 bg-background px-2 py-1 text-lg font-semibold dark:border-white/20"
          placeholder="Patient's name"
          value={placeholder && value === name ? "" : value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          disabled={pending}
        />
        <button
          onClick={save}
          disabled={pending || !value.trim()}
          className="rounded bg-foreground px-3 py-1 text-sm font-medium text-background disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={cancel} className="text-sm text-black/50 hover:underline dark:text-white/50">
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <h1 className="text-xl font-semibold">{name}</h1>
      {canEdit &&
        (placeholder ? (
          <button onClick={() => setEditing(true)} className="tag tag-citric text-xs">
            Add patient&apos;s name
          </button>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="tone-link text-xs hover:underline"
            title="Change the patient's name"
          >
            Rename
          </button>
        ))}
    </span>
  );
}
