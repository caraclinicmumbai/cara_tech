"use client";

// Brand toggle — cycles the design layer (pilot).
//
// Three samples on one button: the current CARA design, enori in blue, and
// enori in pastel violet. The point of it is comparison. A reskin argued from
// screenshots is argued in the abstract; this lets the business sit on the
// screen they actually work all day, with their own data in the rows, and flip
// between the options under their own hands.
//
// Mirrors ThemeToggle: the classes are applied before hydration by the inline
// script in the root layout, and read here through useSyncExternalStore so the
// server snapshot (CARA) matches the first client render.
import { useSyncExternalStore } from "react";

const BRAND_EVENT = "cara-brand-change";

/// The cycle, in order. `classes` is what goes on <html>; the violet variant
/// layers over the blue one, so only its palette differs.
const BRANDS = [
  { key: "cara", label: "CARA", glyph: "◇", classes: [] as string[] },
  { key: "enori", label: "enori · blue", glyph: "◆", classes: ["enori"] },
  { key: "enori-violet", label: "enori · violet", glyph: "◆", classes: ["enori", "enori-violet"] },
] as const;

function subscribe(onChange: () => void) {
  window.addEventListener(BRAND_EVENT, onChange);
  return () => window.removeEventListener(BRAND_EVENT, onChange);
}
function getSnapshot() {
  const el = document.documentElement.classList;
  if (el.contains("enori-violet")) return 2;
  if (el.contains("enori")) return 1;
  return 0;
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
    el.remove("enori", "enori-violet");
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
