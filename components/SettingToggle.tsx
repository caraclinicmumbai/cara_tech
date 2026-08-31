"use client";

// One admin operating switch (§settings). Saves immediately — these are single
// decisions, not a form, and a Save button on a lone checkbox invites the state where
// the screen and the system disagree.
import { useState, useTransition } from "react";

export function SettingToggle({
  label,
  description,
  checked,
  action,
  onLabel,
  offLabel,
}: {
  label: string;
  description: React.ReactNode;
  checked: boolean;
  action: (value: boolean) => Promise<{ ok: boolean; error?: string; info?: string }>;
  onLabel?: string;
  offLabel?: string;
}) {
  const [value, setValue] = useState(checked);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(next: boolean) {
    setValue(next); // optimistic — reverted below if the server refuses
    setMsg(null);
    startTransition(async () => {
      const res = await action(next);
      if (res.ok) setMsg({ kind: "ok", text: res.info ?? "Saved" });
      else {
        setValue(!next);
        setMsg({ kind: "err", text: res.error ?? "Could not save" });
      }
    });
  }

  return (
    <div className="cara-card space-y-2 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="font-medium text-cara-ink">{label}</div>
          <div className="cara-note text-[12px] leading-relaxed">{description}</div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={value}
            disabled={pending}
            onChange={(e) => toggle(e.target.checked)}
            className="h-4 w-4 accent-[var(--cara-ink)]"
          />
          <span className="text-[13px] text-cara-muted">
            {value ? (onLabel ?? "On") : (offLabel ?? "Off")}
          </span>
        </label>
      </div>
      {msg && (
        <p className={`text-[12px] ${msg.kind === "ok" ? "text-[var(--state-success-tx)]" : "text-danger"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
