"use client";

// Shared plumbing for the scheduling setup forms: run a server action, show its
// result, refresh the server-rendered page on success.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type ActionResult = { ok: boolean; error?: string; info?: string; id?: string };

export function useRun() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function run(fn: () => Promise<ActionResult>, onOk?: (r: ActionResult) => void) {
    setMsg(null);
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.info) setMsg({ kind: "ok", text: r.info });
        onOk?.(r);
        router.refresh();
      } else {
        setMsg({ kind: "err", text: r.error ?? "Something went wrong" });
      }
    });
  }

  return { run, pending, msg, setMsg };
}

export function Msg({ msg }: { msg: { kind: "ok" | "err"; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-[12px] ${msg.kind === "ok" ? "txt-good" : "txt-bad"}`}>{msg.text}</p>;
}
