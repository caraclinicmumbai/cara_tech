// WhatsApp chatbot flow definitions (Phase 2 — chatbot builder). Shared vocabulary
// for triggers, priorities, and the node/graph shape so the list UI, the builder,
// and the runtime all agree. The graph itself is React Flow-shaped: nodes + edges.

export const TRIGGER_EVENTS = [
  "inbound_message",
  "template_message",
  "welcome",
  "keyword",
  "stage_change",
] as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export const TRIGGER_EVENT_LABELS: Record<TriggerEvent, string> = {
  inbound_message: "Inbound message",
  template_message: "Template message",
  welcome: "Welcome (first message)",
  keyword: "Keyword match",
  stage_change: "Lead stage change",
};

/// Trigger config for a `stage_change` flow: fire when the lead reaches `stage`;
/// if `campaign` is set, only for leads whose (latest) campaign matches. An empty
/// campaign is a catch-all for that stage. See the matrix in lib/chatbotRuntime.ts.
export type StageTriggerConfig = { stage?: string; campaign?: string };

export function isTriggerEvent(v: string): v is TriggerEvent {
  return (TRIGGER_EVENTS as readonly string[]).includes(v);
}

export const FLOW_PRIORITIES = ["high", "medium", "low"] as const;
export type FlowPriority = (typeof FLOW_PRIORITIES)[number];
export const PRIORITY_LABELS: Record<FlowPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
export function isFlowPriority(v: string): v is FlowPriority {
  return (FLOW_PRIORITIES as readonly string[]).includes(v);
}

// ── Node types (core set) ────────────────────────────────────────────
// The builder palette (Phase 2) offers these; the runtime (Phase 3) executes them.
// Grouped as in the 11Za palette: send / ask / utility / action.

export const FLOW_NODE_TYPES = [
  // Send a message
  "send_text",
  "send_media",
  "send_buttons",
  "send_list",
  "send_template",
  // Ask a question (stores the reply in a variable, waits for it)
  "ask_text",
  "ask_number",
  "ask_phone",
  "ask_email",
  // Utilities / logic
  "condition",
  "switch",
  "delay",
  "business_hours",
  "jump_to",
  // Actions
  "assign_tag",
  "assign_label",
] as const;

export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

export type FlowNodeGroup = "send" | "ask" | "utility" | "action";

export type FlowNodeDef = {
  type: FlowNodeType;
  label: string;
  group: FlowNodeGroup;
};

export const FLOW_NODE_DEFS: FlowNodeDef[] = [
  { type: "send_text", label: "Send Text", group: "send" },
  { type: "send_media", label: "Send Media", group: "send" },
  { type: "send_buttons", label: "Send Buttons", group: "send" },
  { type: "send_list", label: "Send List", group: "send" },
  { type: "send_template", label: "Send Template", group: "send" },
  { type: "ask_text", label: "Ask Text", group: "ask" },
  { type: "ask_number", label: "Ask Number", group: "ask" },
  { type: "ask_phone", label: "Ask Phone", group: "ask" },
  { type: "ask_email", label: "Ask Email", group: "ask" },
  { type: "condition", label: "Condition", group: "utility" },
  { type: "switch", label: "Switch", group: "utility" },
  { type: "delay", label: "Delay", group: "utility" },
  { type: "business_hours", label: "Business Hours", group: "utility" },
  { type: "jump_to", label: "Jump To", group: "utility" },
  { type: "assign_tag", label: "Assign Tag", group: "action" },
  { type: "assign_label", label: "Assign Label", group: "action" },
];

export const FLOW_NODE_GROUP_LABELS: Record<FlowNodeGroup, string> = {
  send: "Send a Message",
  ask: "Ask Questions",
  utility: "Utilities",
  action: "Actions",
};

export function isFlowNodeType(v: string): v is FlowNodeType {
  return (FLOW_NODE_TYPES as readonly string[]).includes(v);
}

// ── Graph shape (React Flow-compatible) ──────────────────────────────

export type FlowNode = {
  id: string;
  type: string; // FlowNodeType (or "trigger" for the start node)
  position: { x: number; y: number };
  data: Record<string, unknown>; // node config (text, buttons, condition, …)
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null; // which output (e.g. a specific button / branch)
};

export type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] };

export const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

/// Coerce an unknown JSON value into a FlowGraph (defensive — the column is Json).
export function asGraph(v: unknown): FlowGraph {
  if (v && typeof v === "object" && Array.isArray((v as FlowGraph).nodes)) {
    const g = v as FlowGraph;
    return { nodes: g.nodes ?? [], edges: Array.isArray(g.edges) ? g.edges : [] };
  }
  return { nodes: [], edges: [] };
}
