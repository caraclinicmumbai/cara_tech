"use client";

// One-tap counsellor status switcher (§presence). Lives in the sticky header so
// changing status is always one tap away — never buried in a settings menu. It
// also doubles as the activity heartbeat: on mount, on a timer, and whenever the
// tab regains focus it pings the server (recording activity) and reconciles the
// pill with the server's view — so an auto-offline shows up here too.
import { useEffect, useRef, useState, useTransition } from "react";
import { AVAILABILITY, availabilityMeta } from "@/lib/presenceStatus";
import { pingPresence, setMyAvailability } from "@/app/(dashboard)/presence-actions";

const HEARTBEAT_MS = 90_000; // ping every 90s while the tab is open

export function StatusSwitcher({ initial }: { initial: string }) {
  const [status, setStatus] = useState(initial);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const boxRef = useRef<HTMLDivElement>(null);

  // Heartbeat + reconcile with the server (picks up server-side auto-offline).
  useEffect(() => {
    let cancelled = false;
    const beat = () =>
      void pingPresence().then((r) => {
        if (!cancelled && r?.availability) setStatus(r.availability);
      });
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    const onFocus = () => beat();
    const onVis = () => {
      if (document.visibilityState === "visible") beat();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function choose(value: string) {
    setOpen(false);
    if (value === status) return;
    const prev = status;
    setStatus(value); // optimistic
    startTransition(async () => {
      const res = await setMyAvailability(value);
      if (!res.ok) setStatus(prev);
      else if (res.availability) setStatus(res.availability);
    });
  }

  const meta = availabilityMeta(status);

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={pending}
        className="cara-chip gap-2 disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={meta.hint}
      >
        <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden />
        <span>{meta.label}</span>
        <span aria-hidden className="text-cara-muted">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Set your status"
          className="absolute right-0 z-20 mt-2 w-64 overflow-hidden rounded-xl border-[0.5px] border-cara-rule bg-cara-page shadow-lg"
        >
          {AVAILABILITY.map((a) => (
            <button
              key={a.value}
              type="button"
              role="option"
              aria-selected={a.value === status}
              onClick={() => choose(a.value)}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-cara-surface ${
                a.value === status ? "bg-cara-surface" : ""
              }`}
            >
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${a.dot}`} aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-cara-ink">{a.label}</span>
                <span className="block text-[11px] leading-tight text-cara-muted">{a.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
