"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Create-lead form. POSTs to /api/leads, which also fires n8n Agent 1.
export function LeadForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") ?? ""),
      phone: String(form.get("phone") ?? ""),
      email: String(form.get("email") ?? "") || undefined,
      interest: String(form.get("interest") ?? "") || undefined,
      source: (String(form.get("source") ?? "manual") || "manual") as
        | "web_form"
        | "referral"
        | "manual",
    };

    const res = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSubmitting(false);
    if (!res.ok) {
      setError("Failed to create lead");
      return;
    }
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  const input =
    "rounded border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 text-sm";

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input name="name" placeholder="Full name" required className={input} />
      <input name="phone" placeholder="Phone (+91...)" required className={input} />
      <input name="email" type="email" placeholder="Email (optional)" className={input} />
      <input name="interest" placeholder="Interest (e.g. Hair treatment)" className={input} />
      <select name="source" className={input} defaultValue="manual">
        <option value="manual">Manual</option>
        <option value="web_form">Web form</option>
        <option value="referral">Referral</option>
      </select>
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create lead & call"}
      </button>
      {error && <p className="text-sm text-red-600 sm:col-span-2">{error}</p>}
    </form>
  );
}
