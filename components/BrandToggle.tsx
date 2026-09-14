"use client";

// Brand toggle — flips the enori design layer on and off (pilot).
//
// The point of it is comparison. A reskin argued from screenshots is argued in
// the abstract; this lets the business sit on the leads list they actually work
// all day and switch between the two designs under their own hands, with their
// own data in the rows. It is also how the Zero Green / Zero Red question gets
// answered honestly — does "overdue" still catch the eye when it is violet.
//
// Mirrors ThemeToggle exactly: the class is applied before hydration by the
// inline script in the root layout, and read here through useSyncExternalStore
// so the server snapshot (CARA) matches the first client render.
import { useSyncExternalStore } from "react";

const BRAND_EVENT = "cara-brand-change";

function subscribe(onChange: () => void) {
  window.addEventListener(BRAND_EVENT, onChange);
  return () => window.removeEventListener(BRAND_EVENT, onChange);
}
function getSnapshot() {
  return document.documentElement.classList.contains("enori");
}
function getServerSnapshot() {
  return false; // SSR renders CARA; the init script adds `enori` before paint
}

export function BrandToggle() {
  const enori = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next = !enori;
    document.documentElement.classList.toggle("enori", next);
    try {
      localStorage.setItem("cara-brand", next ? "enori" : "cara");
    } catch {
      // localStorage unavailable (private mode etc.) — the choice still holds
      // for this session, which is all a demo needs.
    }
    window.dispatchEvent(new Event(BRAND_EVENT));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={enori ? "Switch to the CARA design" : "Switch to the enori design"}
      aria-pressed={enori}
      className="cara-chip gap-2"
      title="Pilot: switch between the current CARA design and the enori brand"
      suppressHydrationWarning
    >
      <span aria-hidden suppressHydrationWarning>
        {enori ? "◆" : "◇"}
      </span>
      <span suppressHydrationWarning>{enori ? "enori" : "CARA"}</span>
    </button>
  );
}
