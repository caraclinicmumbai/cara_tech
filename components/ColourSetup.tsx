"use client";

// Settings → Colours: the colour of every lead stage and quote status, built-in and custom
// (lib/stageColors.ts holds the defaults, PipelineStatus.color the clinic's choices). Each
// row previews the pill as it will look, live while picking; Save stores it, Reset puts the
// default back.
import { useState, type CSSProperties } from "react";
import { setPipelineColor } from "@/app/(dashboard)/settings/actions";
import { Msg, useRun } from "@/components/scheduling/useRun";
import { QuoteStatusPill } from "@/components/QuoteStatusPill";
import { isHexColor, stageVars } from "@/lib/stageColors";
import type { PipelineKind, QuoteStatusOption, StageOption } from "@/lib/pipeline";

type Entry = { key: string; label: string; color: string; defaultColor: string; system: boolean };

export function ColourSetup({
  leadStages,
  quoteStatuses,
}: {
  leadStages: StageOption[];
  quoteStatuses: QuoteStatusOption[];
}) {
  return (
    <div className="space-y-4">
      <ColourList kind="lead_stage" title="Lead stages" entries={leadStages} />
      <ColourList kind="quote_status" title="Quote statuses" entries={quoteStatuses} />
    </div>
  );
}

function ColourList({ kind, title, entries }: { kind: PipelineKind; title: string; entries: Entry[] }) {
  const [open, setOpen] = useState(false);
  const changed = entries.filter((e) => e.color !== e.defaultColor).length;
  return (
    <div className="cara-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-cara-ink">{title}</span>
          <span className="text-[12px] text-cara-faint">
            {entries.length} · {changed} changed from the default
          </span>
        </div>
        <button className="cara-btn" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit colours"}</button>
      </div>
      {!open && (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <Preview key={e.key} kind={kind} label={e.label} color={e.color} />
          ))}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-cara-rule pt-3">
          {entries.map((e) => (
            <ColourRow key={`${e.key}:${e.color}`} kind={kind} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function ColourRow({ kind, entry }: { kind: PipelineKind; entry: Entry }) {
  const [color, setColor] = useState(entry.color);
  const [text, setText] = useState(entry.color);
  const { run, pending, msg } = useRun();
  const dirty = color !== entry.color;

  function pick(v: string) {
    setText(v.toUpperCase());
    if (isHexColor(v)) setColor(v.toUpperCase());
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-60">
          <Preview kind={kind} label={entry.label} color={color} />
        </div>
        <input
          type="color"
          className="h-8 w-10 cursor-pointer rounded border border-cara-rule bg-transparent p-0.5"
          value={color.toLowerCase()}
          onChange={(e) => pick(e.target.value)}
          aria-label={`Colour for ${entry.label}`}
        />
        <input
          className="cara-input w-28! font-mono text-[12px]"
          value={text}
          maxLength={7}
          onChange={(e) => pick(e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)}
          aria-label={`Hex code for ${entry.label}`}
        />
        <button
          className="cara-btn cara-btn-primary"
          disabled={pending || !dirty}
          onClick={() => run(() => setPipelineColor({ kind, key: entry.key, color }))}
        >
          Save
        </button>
        {entry.color !== entry.defaultColor && (
          <button
            className="cara-btn"
            disabled={pending}
            title={`Back to the default, ${entry.defaultColor}`}
            onClick={() => run(() => setPipelineColor({ kind, key: entry.key, color: null }))}
          >
            Reset
          </button>
        )}
        {dirty && (
          <button className="cara-btn" disabled={pending} onClick={() => pick(entry.color)}>
            Undo
          </button>
        )}
        {!entry.system && <span className="text-[12px] text-cara-faint">Custom</span>}
      </div>
      <Msg msg={msg} />
    </div>
  );
}

/// The pill as the CRM shows it: a stage pill (tinted) for lead stages, a solid pill for
/// quote statuses.
function Preview({ kind, label, color }: { kind: PipelineKind; label: string; color: string }) {
  if (kind === "quote_status") return <QuoteStatusPill label={label} color={color} />;
  return (
    <span
      className="stage-pill inline-flex rounded-full border px-2.5 py-0.5 text-xs"
      style={stageVars(color) as CSSProperties}
    >
      {label}
    </span>
  );
}
