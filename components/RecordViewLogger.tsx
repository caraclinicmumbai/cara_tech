"use client";

// Fires once per page-open to record that this user LOOKED at the record (§compliance).
// Renders nothing. Guarded so React strict-mode / re-renders don't double-log; the
// server route also dedupes within a short window.
import { useEffect, useRef } from "react";

export function RecordViewLogger({ entityType, entityId }: { entityType: string; entityId: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    fetch("/api/audit/view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType, entityId }),
      keepalive: true,
    }).catch(() => {});
  }, [entityType, entityId]);
  return null;
}
