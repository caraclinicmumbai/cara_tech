"use client";

// Edit a lead's core details (name / phone / email / interest). Collapsed by default;
// changing the phone reveals a required reason field (compliance-sensitive). Each saved
// change is audited server-side.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { editLead } from "@/app/(dashboard)/leads/actions";

const inputCls = "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

export function LeadEditForm({
  leadId,
  name,
  phone,
  email,
  interest,
}: {
  leadId: string;
  name: string;
  phone: string;
  email: string | null;
  interest: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name, phone, email: email ?? "", interest: interest ?? "", reason: "" });

  const phoneChanged = f.phone.trim() !== phone;

  const save = () =>
    startTransition(async () => {
      const res = await editLead(leadId, {
        name: f.name, phone: f.phone, email: f.email, interest: f.interest, reason: f.reason || null,
      });
      if (res.ok) { setOpen(false); router.refresh(); }
      else window.alert(res.error ?? "Could not save");
    });

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="text-xs text-blue-600 hover:underline dark:text-blue-400">
        Edit details
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded border border-black/10 p-3 dark:border-white/15">
      <div className="flex flex-wrap gap-2">
        <input className={inputCls} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={inputCls} placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <input className={inputCls} placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input className={`${inputCls} min-w-[16rem] flex-1`} placeholder="Interest" value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} />
      </div>
      {phoneChanged && (
        <input className={`${inputCls} w-full`} placeholder="Reason for changing the phone number (required)"
          value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      )}
      <div className="flex items-center gap-2">
        <button disabled={pending || !f.name.trim() || !f.phone.trim() || (phoneChanged && !f.reason.trim())}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          onClick={save}>
          Save
        </button>
        <button className="text-sm text-black/50 hover:underline dark:text-white/50"
          onClick={() => { setF({ name, phone, email: email ?? "", interest: interest ?? "", reason: "" }); setOpen(false); }}>
          Cancel
        </button>
        {phoneChanged && <span className="text-xs text-amber-700 dark:text-amber-400">Phone change requires a reason.</span>}
      </div>
    </div>
  );
}
