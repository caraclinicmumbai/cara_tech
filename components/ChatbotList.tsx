"use client";

// Chatbot flow list (Phase 2 — chatbot builder), modeled on 11Za's Chatbot-List:
// name, trigger event, priority, expire-on, and per-row actions (active toggle,
// edit → builder, duplicate, delete). Search + a "New flow" creator on top.
import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createFlow,
  setFlowActive,
  setFlowPriority,
  setFlowTrigger,
  duplicateFlow,
  deleteFlow,
} from "@/app/(dashboard)/chatbot/actions";
import {
  TRIGGER_EVENTS,
  TRIGGER_EVENT_LABELS,
  FLOW_PRIORITIES,
  PRIORITY_LABELS,
  type TriggerEvent,
  type FlowPriority,
} from "@/lib/chatbotFlows";

type FlowRow = {
  id: string;
  name: string;
  triggerEvent: string;
  priority: string;
  active: boolean;
  expireOn: string | null;
};

const inputCls =
  "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

function priorityTone(p: string): string {
  return p === "high"
    ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
    : p === "medium"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60";
}

export function ChatbotList({ flows }: { flows: FlowRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [nf, setNf] = useState({ name: "", triggerEvent: "inbound_message", priority: "high" });

  const run = (fn: () => Promise<{ ok: boolean; error?: string; id?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) router.refresh();
      else window.alert(res.error ?? "Action failed");
    });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? flows.filter((f) => f.name.toLowerCase().includes(q)) : flows;
  }, [flows, search]);

  return (
    <div className="space-y-4">
      {/* Header: search + New flow */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          className={`${inputCls} w-64`}
          placeholder="Search flows…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background"
        >
          + New flow
        </button>
      </div>

      {creating && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-black/10 p-3 dark:border-white/15">
          <input
            className={inputCls}
            placeholder="Flow name"
            value={nf.name}
            onChange={(e) => setNf({ ...nf, name: e.target.value })}
            autoFocus
          />
          <select className={inputCls} value={nf.triggerEvent} onChange={(e) => setNf({ ...nf, triggerEvent: e.target.value })}>
            {TRIGGER_EVENTS.map((t) => (
              <option key={t} value={t}>{TRIGGER_EVENT_LABELS[t]}</option>
            ))}
          </select>
          <select className={inputCls} value={nf.priority} onChange={(e) => setNf({ ...nf, priority: e.target.value })}>
            {FLOW_PRIORITIES.map((p) => (
              <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
            ))}
          </select>
          <button
            disabled={pending || !nf.name.trim()}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
            onClick={() =>
              run(() =>
                createFlow(nf).then((r) => {
                  if (r.ok && r.id) {
                    // Jump straight into the builder for the new flow.
                    router.push(`/chatbot/${r.id}`);
                  }
                  return r;
                }),
              )
            }
          >
            Create & edit
          </button>
          <button className="text-sm text-black/50 hover:underline dark:text-white/50" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded border border-black/10 dark:border-white/15">
        <table className="min-w-full text-sm">
          <thead className="bg-black/5 text-left dark:bg-white/10">
            <tr>
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Trigger event</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Expire on</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((f, i) => (
              <tr key={f.id} className="border-t border-black/5 dark:border-white/10">
                <td className="px-3 py-2 text-black/50 dark:text-white/50">{i + 1}</td>
                <td className="px-3 py-2 font-medium">
                  <Link href={`/chatbot/${f.id}`} className="hover:underline">{f.name}</Link>
                </td>
                <td className="px-3 py-2">
                  <select
                    className={inputCls}
                    defaultValue={f.triggerEvent}
                    disabled={pending}
                    onChange={(e) => run(() => setFlowTrigger(f.id, e.target.value))}
                  >
                    {TRIGGER_EVENTS.map((t) => (
                      <option key={t} value={t}>{TRIGGER_EVENT_LABELS[t as TriggerEvent]}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    className={`${inputCls} ${priorityTone(f.priority)}`}
                    defaultValue={f.priority}
                    disabled={pending}
                    onChange={(e) => run(() => setFlowPriority(f.id, e.target.value))}
                  >
                    {FLOW_PRIORITIES.map((p) => (
                      <option key={p} value={p}>{PRIORITY_LABELS[p as FlowPriority]}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-black/60 dark:text-white/60">
                  {f.expireOn ? new Date(f.expireOn).toLocaleDateString() : "Never"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {/* Active toggle */}
                  <button
                    disabled={pending}
                    onClick={() => run(() => setFlowActive(f.id, !f.active))}
                    title={f.active ? "Active — click to turn off" : "Inactive — click to turn on"}
                    className={`mr-3 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      f.active
                        ? "bg-green-600/15 text-green-700 dark:text-green-400"
                        : "bg-black/10 text-black/50 dark:bg-white/10 dark:text-white/50"
                    }`}
                  >
                    {f.active ? "On" : "Off"}
                  </button>
                  <Link href={`/chatbot/${f.id}`} className="mr-2 text-xs text-blue-600 hover:underline dark:text-blue-400">
                    Edit
                  </Link>
                  <button
                    disabled={pending}
                    className="mr-2 text-xs text-black/60 hover:underline dark:text-white/60"
                    onClick={() => run(() => duplicateFlow(f.id))}
                  >
                    Duplicate
                  </button>
                  <button
                    disabled={pending}
                    className="text-xs text-red-600 hover:underline dark:text-red-400"
                    onClick={() => {
                      if (window.confirm(`Delete flow "${f.name}"? This can't be undone.`)) run(() => deleteFlow(f.id));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-black/50 dark:text-white/50">
                  {flows.length === 0 ? "No flows yet — create your first WhatsApp chatbot flow." : "No flows match your search."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
