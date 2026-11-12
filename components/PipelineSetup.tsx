"use client";

// Lead stages & quote statuses on the Settings page (lib/pipeline.ts). Built-ins can be
// renamed; custom ones can also be added and deleted. Deleting one with leads / quotes
// in it asks where they go.
import { useState } from "react";
import { addPipelineStatus, deletePipelineStatus, renamePipelineStatus } from "@/app/(dashboard)/settings/actions";
import { Msg, useRun } from "@/components/scheduling/useRun";
import type { PipelineKind, QuoteStatusOption, StageOption } from "@/lib/pipeline";

type Entry = { key: string; label: string; system: boolean; note?: string; group?: string };

const CATEGORY_LABEL: Record<QuoteStatusOption["category"], string> = {
  open: "Open — still in play",
  won: "Won",
  closed: "Closed — not won",
};

export function PipelineSetup({
  leadStages,
  quoteStatuses,
  stageCounts,
  quoteCounts,
}: {
  leadStages: StageOption[];
  quoteStatuses: QuoteStatusOption[];
  stageCounts: Record<string, number>;
  quoteCounts: Record<string, number>;
}) {
  const stageEntries: Entry[] = leadStages.map((s) => ({
    ...s,
    note: s.note ?? `Custom · after ${leadStages.find((x) => x.key === s.after)?.label ?? s.after}`,
  }));
  const quoteEntries: Entry[] = quoteStatuses.map((s) => ({ ...s, note: s.note ?? "Custom", group: CATEGORY_LABEL[s.category] }));

  return (
    <div className="space-y-4">
      <PipelineList
        kind="lead_stage"
        title="Lead stages"
        entries={stageEntries}
        counts={stageCounts}
        countNoun="lead"
        moveTargets={(key) => leadStages.filter((s) => s.key !== key && s.key !== "lost")}
        addPlacements={leadStages
          .filter((s) => s.system && s.key !== "lost")
          .map((s) => ({ value: s.key, label: `After “${s.label}”` }))}
      />
      <PipelineList
        kind="quote_status"
        title="Quote statuses"
        entries={quoteEntries}
        counts={quoteCounts}
        countNoun="quote"
        moveTargets={(key) => {
          const cat = quoteStatuses.find((s) => s.key === key)?.category;
          return quoteStatuses.filter(
            (s) => s.key !== key && s.category === cat && !["rejected", "withdrawn", "replaced", "accepted"].includes(s.key),
          );
        }}
        addPlacements={[
          { value: "open", label: "Open — still in play (counts as an open quote)" },
          { value: "closed", label: "Closed — not won" },
        ]}
      />
    </div>
  );
}

function PipelineList({
  kind,
  title,
  entries,
  counts,
  countNoun,
  moveTargets,
  addPlacements,
}: {
  kind: PipelineKind;
  title: string;
  entries: Entry[];
  counts: Record<string, number>;
  countNoun: string;
  moveTargets: (key: string) => { key: string; label: string }[];
  addPlacements: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [placement, setPlacement] = useState(addPlacements[0]?.value ?? "");
  const { run, pending, msg } = useRun();
  const noun = kind === "lead_stage" ? "stage" : "status";

  return (
    <div className="cara-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-cara-ink">{title}</span>
          <span className="text-[12px] text-cara-faint">
            {entries.length} · {entries.filter((e) => !e.system).length} custom
          </span>
        </div>
        <button className="cara-btn" onClick={() => setOpen(!open)}>{open ? "Close" : `Edit ${noun === "stage" ? "stages" : "statuses"}`}</button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-cara-rule pt-3">
          {entries.map((e, i) => (
            <div key={e.key}>
              {e.group && e.group !== entries[i - 1]?.group && (
                <div className="pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-cara-muted">{e.group}</div>
              )}
              <PipelineRow kind={kind} entry={e} count={counts[e.key] ?? 0} countNoun={countNoun} targets={moveTargets(e.key)} />
            </div>
          ))}
          <div className="space-y-2 border-t border-cara-rule pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-cara-muted">Add a {noun}</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="cara-input w-56!"
                placeholder={kind === "lead_stage" ? "Name * (e.g. Second opinion)" : "Name * (e.g. On hold)"}
                value={label}
                maxLength={60}
                onChange={(e) => setLabel(e.target.value)}
              />
              <select className="cara-select w-auto!" value={placement} onChange={(e) => setPlacement(e.target.value)} aria-label={kind === "lead_stage" ? "Where it goes" : "Kind"}>
                {addPlacements.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <button
                className="cara-btn cara-btn-primary"
                disabled={pending || !label.trim()}
                onClick={() => run(() => addPipelineStatus({ kind, label, placement }), () => setLabel(""))}
              >
                Add {noun}
              </button>
            </div>
            <Msg msg={msg} />
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineRow({
  kind,
  entry,
  count,
  countNoun,
  targets,
}: {
  kind: PipelineKind;
  entry: Entry;
  count: number;
  countNoun: string;
  targets: { key: string; label: string }[];
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [label, setLabel] = useState(entry.label);
  const [moveTo, setMoveTo] = useState("");
  const { run, pending, msg } = useRun();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-cara-ink">{entry.label}</span>
          <span className="text-[12px] text-cara-muted">
            {count} {countNoun}{count === 1 ? "" : "s"}
          </span>
          {entry.note && <span className="text-[12px] text-cara-faint">· {entry.note}</span>}
        </div>
        <div className="flex gap-1.5">
          <button className="cara-btn" onClick={() => { setLabel(entry.label); setMode(mode === "rename" ? "view" : "rename"); }}>
            {mode === "rename" ? "Close" : "Rename"}
          </button>
          {entry.system ? (
            <span className="cara-btn pointer-events-none opacity-40" title="Built-in — the automation depends on it, so it can be renamed but not deleted">
              Built-in
            </span>
          ) : (
            <button className="cara-btn" onClick={() => { setMoveTo(""); setMode(mode === "delete" ? "view" : "delete"); }}>
              {mode === "delete" ? "Cancel" : "Delete"}
            </button>
          )}
        </div>
      </div>
      {mode === "rename" && (
        <div className="flex flex-wrap items-center gap-2">
          <input className="cara-input w-56!" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} aria-label="New name" />
          <button
            className="cara-btn cara-btn-primary"
            disabled={pending || !label.trim()}
            onClick={() => run(() => renamePipelineStatus({ kind, key: entry.key, label }), () => setMode("view"))}
          >
            Save
          </button>
        </div>
      )}
      {mode === "delete" && (
        <div className="flex flex-wrap items-center gap-2">
          {count > 0 ? (
            <>
              <span className="text-[12px] text-cara-muted">
                Move its {count} {countNoun}{count === 1 ? "" : "s"} to
              </span>
              <select className="cara-select w-auto!" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to">
                <option value="">Choose…</option>
                {targets.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </>
          ) : (
            <span className="text-[12px] text-cara-muted">Nothing is in this {kind === "lead_stage" ? "stage" : "status"}.</span>
          )}
          <button
            className="cara-btn"
            disabled={pending || (count > 0 && !moveTo)}
            onClick={() => {
              if (!window.confirm(`Delete "${entry.label}"?${count > 0 ? ` Its ${count} ${countNoun}${count === 1 ? "" : "s"} will move.` : ""}`)) return;
              run(() => deletePipelineStatus({ kind, key: entry.key, moveTo }), () => setMode("view"));
            }}
          >
            Delete
          </button>
        </div>
      )}
      <Msg msg={msg} />
    </div>
  );
}
