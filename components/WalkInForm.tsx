"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Walk-in / front-desk entry form. Consent (iPad/written) is mandatory and must
// be confirmed before the record can be created (§3.1.13). No AI call is ever
// triggered for walk-ins — this form makes that explicit to staff.
export function WalkInForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [consentMethod, setConsentMethod] = useState<"" | "ipad" | "written">("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);

  const canSubmit = !!consentMethod && consentConfirmed && !submitting;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") ?? ""),
      phone: String(form.get("phone") ?? ""),
      email: String(form.get("email") ?? "") || undefined,
      interest: String(form.get("interest") ?? "") || undefined,
      consentMethod,
    };

    const res = await fetch("/api/leads/walk-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setSubmitting(false);
    if (!res.ok) {
      setError("Failed to save walk-in lead. Please try again.");
      return;
    }
    (e.target as HTMLFormElement).reset();
    setConsentMethod("");
    setConsentConfirmed(false);
    setDone(true);
    router.refresh();
  }

  const input =
    "rounded border border-black/15 dark:border-white/20 bg-transparent px-3 py-2 text-sm";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input name="name" placeholder="Full name" required className={input} />
        <input name="phone" placeholder="Phone (+91…)" required className={input} />
        <input name="email" type="email" placeholder="Email (optional)" className={input} />
        <input name="interest" placeholder="Interest (e.g. Hair transplant)" className={input} />
      </div>

      {/* Consent — mandatory before the record is created (§3.1.13). */}
      <fieldset className="rounded border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
        <legend className="px-1 text-sm font-medium">Consent (required)</legend>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-black/60 dark:text-white/60">Consent collected via:</span>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="consentMethod"
              checked={consentMethod === "ipad"}
              onChange={() => setConsentMethod("ipad")}
            />
            iPad (digital)
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="consentMethod"
              checked={consentMethod === "written"}
              onChange={() => setConsentMethod("written")}
            />
            Written (paper)
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={consentConfirmed}
            onChange={(e) => setConsentConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I confirm the patient completed and signed/acknowledged the consent form
            before this record was created.
          </span>
        </label>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
        >
          {submitting ? "Saving…" : "Save walk-in lead"}
        </button>
        <span className="text-xs text-black/50 dark:text-white/50">
          No AI call is placed — routed to manual follow-up.
        </span>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {done && (
        <p className="text-sm text-green-600">
          Walk-in lead saved to the manual follow-up queue. No automated call was triggered.
        </p>
      )}
    </form>
  );
}
