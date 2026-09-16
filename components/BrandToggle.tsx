"use client";

// Brand toggle — switches the design layer (pilot).
//
// Two samples on one button: the current CARA design and enori. The point of it
// is comparison. A reskin argued from screenshots is argued in the abstract;
// this lets the business sit on the screen they actually work all day, with
// their own data in the rows, and flip between the two under their own hands.
//
// A pastel-violet sample lived here too and was dropped — the purple did not
// work on a real screen, which is what the toggle was for.
//
// Mirrors ThemeToggle: the classes are applied before hydration by the inline
// script in the root layout, and read here through useSyncExternalStore so the
// server snapshot (CARA) matches the first client render.
import { useSyncExternalStore } from "react";

const BRAND_EVENT = "cara-brand-change";

const BRANDS = [
  { key: "cara", label: "CARA", glyph: "◇", classes: [] as string[] },
  { key: "enori", label: "enori", glyph: "◆", classes: ["enori"] },
] as const;

function subscribe(onChange: () => void) {
  window.addEventListener(BRAND_EVENT, onChange);
  return () => window.removeEventListener(BRAND_EVENT, onChange);
}
function getSnapshot() {
  return document.documentElement.classList.contains("enori") ? 1 : 0;
}
function getServerSnapshot() {
  return 0; // SSR renders CARA; the init script applies the saved choice pre-paint
}

export function BrandToggle() {
  const index = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const current = BRANDS[index];

  function cycle() {
    const next = BRANDS[(index + 1) % BRANDS.length];
    const el = document.documentElement.classList;
    el.remove("enori");
    for (const c of next.classes) el.add(c);
    try {
      localStorage.setItem("cara-brand", next.key);
    } catch {
      // localStorage unavailable (private mode etc.) — the choice still holds
      // for this session, which is all a demo needs.
    }
    window.dispatchEvent(new Event(BRAND_EVENT));
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Design: ${current.label}. Switch to ${BRANDS[(index + 1) % BRANDS.length].label}`}
      className="cara-chip gap-2"
      title="Pilot: cycle between the CARA design and the two enori samples"
      suppressHydrationWarning
    >
      <span aria-hidden suppressHydrationWarning>
        {current.glyph}
      </span>
      <span suppressHydrationWarning>{current.label}</span>
    </button>
  );
}
