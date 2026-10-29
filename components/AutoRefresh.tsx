"use client";

// Re-render the current server page on a timer, so lists that change underneath the viewer
// (a missed call landing in the call log) appear without a manual refresh. Only while the
// tab is visible, and once immediately on coming back to it. `router.refresh()` re-runs the
// server components and keeps client state (open forms, scroll), so it is safe to leave on.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ everyMs = 15_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, everyMs]);
  return null;
}
