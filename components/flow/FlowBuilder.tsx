"use client";

// Visual chatbot flow builder (Phase 2), 11Za-style. A React Flow canvas with a
// trigger start node, draggable/connectable nodes from a grouped palette, a per-node
// config panel, and Save. The graph persists to ChatbotFlow.graph; the runtime
// (Phase 3) walks it. Node specs (fields, outputs, summaries) live in nodeConfig.ts.
import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { saveFlowGraph } from "@/app/(dashboard)/chatbot/actions";
import {
  FLOW_NODE_DEFS,
  FLOW_NODE_GROUP_LABELS,
  type FlowNodeGroup,
  type FlowNode,
  type FlowEdge,
} from "@/lib/chatbotFlows";
import { specFor, type FieldDef } from "@/components/flow/nodeConfig";

const MAX_CARDS = 130;

const GROUP_COLOR: Record<string, string> = {
  trigger: "#6366f1",
  send: "#16a34a",
  ask: "#0891b2",
  utility: "#d97706",
  action: "#db2777",
};

function groupOf(type: string): string {
  if (type === "trigger") return "trigger";
  return specFor(type).group ?? "send";
}

// ── Custom node (one component for every type; reads its spec) ──
function FlowNodeView({ type, data, selected }: NodeProps) {
  const t = type ?? "send_text";
  const spec = specFor(t);
  const outs = spec.outputs((data as Record<string, unknown>) ?? {});
  const color = GROUP_COLOR[groupOf(t)];
  return (
    <div
      className="rounded-md border bg-white text-black shadow-sm dark:bg-neutral-900 dark:text-white"
      style={{ width: 210, borderColor: selected ? color : "rgba(0,0,0,0.15)", borderWidth: selected ? 2 : 1 }}
    >
      {!spec.noTarget && <Handle type="target" position={Position.Top} />}
      <div className="rounded-t-md px-3 py-1.5 text-xs font-semibold text-white" style={{ background: color }}>
        {spec.label}
      </div>
      <div className="px-3 py-2 text-xs text-black/70 dark:text-white/70">
        <div className="line-clamp-3 whitespace-pre-wrap break-words">
          {spec.summary((data as Record<string, unknown>) ?? {})}
        </div>
      </div>
      {outs.map((o, i) => (
        <div key={o.id}>
          <Handle
            type="source"
            position={Position.Bottom}
            id={o.id}
            style={{ left: `${((i + 1) / (outs.length + 1)) * 100}%` }}
          />
          {outs.length > 1 && o.label && (
            <span
              className="absolute translate-x-[-50%] text-[9px] text-black/50 dark:text-white/50"
              style={{ left: `${((i + 1) / (outs.length + 1)) * 100}%`, bottom: -14 }}
            >
              {o.label}
            </span>
          )}
        </div>
      ))}
      {/* extra bottom padding when there are labelled branches */}
      {outs.length > 1 && <div className="h-3" />}
    </div>
  );
}

const NODE_TYPE_KEYS = ["trigger", ...FLOW_NODE_DEFS.map((d) => d.type)];
const nodeTypes = Object.fromEntries(NODE_TYPE_KEYS.map((k) => [k, FlowNodeView]));

export type BuilderProps = {
  flowId: string;
  name: string;
  triggerLabel: string;
  initialNodes: FlowNode[];
  initialEdges: FlowEdge[];
};

export function FlowBuilder({ flowId, name, triggerLabel, initialNodes, initialEdges }: BuilderProps) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes as unknown as Node[]);
  const [edges, setEdges] = useState<Edge[]>(initialEdges as unknown as Edge[]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, startSave] = useTransition();

  const onNodesChange = useCallback((c: NodeChange[]) => { setNodes((n) => applyNodeChanges(c, n)); setDirty(true); }, []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => { setEdges((e) => applyEdgeChanges(c, e)); setDirty(true); }, []);
  const onConnect = useCallback((c: Connection) => {
    setEdges((e) => addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed } }, e));
    setDirty(true);
  }, []);

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId]);

  const addNode = (type: string) => {
    const count = nodes.length;
    const id = `${type}-${count}-${Math.round(nodes.reduce((a, n) => a + n.position.x, 0)) % 1000}`;
    const node: Node = {
      id: `${id}-${count}`,
      type,
      position: { x: 120 + (count % 5) * 40, y: 120 + count * 30 },
      data: {},
    };
    setNodes((n) => [...n, node]);
    setSelectedId(node.id);
    setDirty(true);
  };

  const updateData = (key: string, value: unknown) => {
    if (!selected) return;
    setNodes((n) => n.map((nd) => (nd.id === selected.id ? { ...nd, data: { ...nd.data, [key]: value } } : nd)));
    setDirty(true);
  };

  const deleteSelected = () => {
    if (!selected || selected.type === "trigger") return;
    setNodes((n) => n.filter((nd) => nd.id !== selected.id));
    setEdges((e) => e.filter((ed) => ed.source !== selected.id && ed.target !== selected.id));
    setSelectedId(null);
    setDirty(true);
  };

  const save = () => startSave(async () => {
    const res = await saveFlowGraph(flowId, { nodes, edges });
    if (res.ok) setDirty(false);
    else window.alert(res.error ?? "Save failed");
  });

  const palette = useMemo(() => {
    const groups: Record<FlowNodeGroup, typeof FLOW_NODE_DEFS> = { send: [], ask: [], utility: [], action: [] };
    for (const d of FLOW_NODE_DEFS) groups[d.group].push(d);
    return groups;
  }, []);

  return (
    <div className="flex h-[78vh] flex-col rounded-lg border border-black/10 dark:border-white/15">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-black/10 px-3 py-2 dark:border-white/15">
        <Link href="/chatbot" className="text-sm text-black/50 hover:underline dark:text-white/50">← Back</Link>
        <span className="font-semibold">{name}</span>
        <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
          Cards: {nodes.length}/{MAX_CARDS}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas */}
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={null}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {/* Right rail: config panel when a node is selected, else the palette */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-black/10 dark:border-white/15">
          {selected ? (
            <ConfigPanel
              key={selected.id}
              type={selected.type ?? "send_text"}
              data={(selected.data as Record<string, unknown>) ?? {}}
              onChange={updateData}
              onDelete={selected.type === "trigger" ? undefined : deleteSelected}
              triggerLabel={triggerLabel}
            />
          ) : (
            <div className="p-3">
              <p className="mb-2 text-xs text-black/50 dark:text-white/50">
                Click a block to add it, then connect the dots. Select a block to edit it.
              </p>
              {(Object.keys(palette) as FlowNodeGroup[]).map((g) => (
                <div key={g} className="mb-4">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
                    {FLOW_NODE_GROUP_LABELS[g]}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {palette[g].map((d) => (
                      <button
                        key={d.type}
                        onClick={() => addNode(d.type)}
                        className="rounded border border-black/10 px-2 py-1.5 text-left text-xs hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                        style={{ borderLeft: `3px solid ${GROUP_COLOR[g]}` }}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfigPanel({
  type,
  data,
  onChange,
  onDelete,
  triggerLabel,
}: {
  type: string;
  data: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onDelete?: () => void;
  triggerLabel: string;
}) {
  const spec = specFor(type);
  const inputCls = "w-full rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{spec.label}</h3>
        {onDelete && (
          <button onClick={onDelete} className="text-xs text-red-600 hover:underline dark:text-red-400">Delete</button>
        )}
      </div>

      {type === "trigger" && (
        <p className="rounded bg-black/5 px-2 py-1.5 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
          Fires on: <span className="font-medium">{triggerLabel}</span>. Edit the trigger from the flow list.
        </p>
      )}

      {spec.fields.map((f: FieldDef) => {
        const val = data[f.key];
        if (f.kind === "textarea") {
          return (
            <label key={f.key} className="block space-y-1">
              <span className="text-xs text-black/60 dark:text-white/60">{f.label}</span>
              <textarea className={`${inputCls} min-h-20`} placeholder={f.placeholder}
                value={typeof val === "string" ? val : ""} onChange={(e) => onChange(f.key, e.target.value)} />
            </label>
          );
        }
        if (f.kind === "list") {
          const text = Array.isArray(val) ? val.join("\n") : "";
          return (
            <label key={f.key} className="block space-y-1">
              <span className="text-xs text-black/60 dark:text-white/60">{f.label}</span>
              <textarea className={`${inputCls} min-h-20`} placeholder={f.placeholder}
                value={text}
                onChange={(e) => onChange(f.key, e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />
            </label>
          );
        }
        return (
          <label key={f.key} className="block space-y-1">
            <span className="text-xs text-black/60 dark:text-white/60">{f.label}</span>
            <input className={inputCls} type={f.kind === "number" ? "number" : "text"} placeholder={f.placeholder}
              value={typeof val === "string" || typeof val === "number" ? String(val) : ""}
              onChange={(e) => onChange(f.key, f.kind === "number" ? Number(e.target.value) : e.target.value)} />
          </label>
        );
      })}

      {spec.fields.length === 0 && type !== "trigger" && (
        <p className="text-xs text-black/40 dark:text-white/40">No settings for this block.</p>
      )}
    </div>
  );
}
