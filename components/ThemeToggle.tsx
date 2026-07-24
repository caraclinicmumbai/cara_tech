"use client";

// Light/dark theme toggle. The initial theme is applied before hydration by an
// inline script in the root layout (no flash); this button reads the live `.dark`
// class off <html> via useSyncExternalStore — which renders the server snapshot
// (light) during hydration so there's no mismatch, then reconciles to the real
// value — and flips + persists the choice on click.
import { useSyncExternalStore } from "react";

const THEME_EVENT = "cara-theme-change";

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}
function getSnapshot() {
  return document.documentElement.classList.contains("dark");
}
function getServerSnapshot() {
  return false; // SSR/first hydration render assumes light to match server HTML
}

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("cara-theme", next ? "dark" : "light");
    } catch {
      // localStorage unavailable (private mode etc.) — theme still applies for the session.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={dark}
      className="cara-chip gap-2"
      suppressHydrationWarning
    >
      <span aria-hidden suppressHydrationWarning>{dark ? "☀︎" : "☾"}</span>
      <span suppressHydrationWarning>{dark ? "Light" : "Dark"}</span>
    </button>
  );
}
