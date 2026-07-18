"use client";

import { useActionState } from "react";
import { authenticate } from "./actions";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [errorMessage, formAction, pending] = useActionState(
    authenticate,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      <div className="space-y-1">
        <label htmlFor="email" className="cara-label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="cara-input"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="cara-label">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="cara-input"
        />
      </div>

      {errorMessage && (
        <p className="cara-callout cara-callout-danger">{errorMessage}</p>
      )}

      <button type="submit" disabled={pending} className="cara-btn cara-btn-primary w-full">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
