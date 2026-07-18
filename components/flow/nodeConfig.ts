// Per-node-type spec for the chatbot builder (Phase 2): what fields each node
// exposes in the config panel, how it summarises itself on the canvas, and its
// output handles (for branching). Shared by the node view + the config panel; the
// runtime (Phase 3) will read the same `data` keys.
import type { FlowNodeGroup } from "@/lib/chatbotFlows";

export type FieldKind = "text" | "textarea" | "number" | "list";

export type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
};

export type Output = { id: string; label?: string };

export type NodeSpec = {
  label: string;
  group?: FlowNodeGroup;
  fields: FieldDef[];
  /// Output handles (bottom). Dynamic for branching nodes (condition, buttons).
  outputs: (data: Record<string, unknown>) => Output[];
  /// One-line summary shown on the node body.
  summary: (data: Record<string, unknown>) => string;
  /// Trigger node has no incoming handle.
  noTarget?: boolean;
};

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
const SINGLE: Output[] = [{ id: "out" }];

export const NODE_SPECS: Record<string, NodeSpec> = {
  trigger: {
    label: "Trigger",
    fields: [],
    noTarget: true,
    outputs: () => SINGLE,
    summary: (d) => s(d.label) || "When this flow starts",
  },

  // ── Send a Message ──
  send_text: {
    label: "Send Text", group: "send",
    fields: [{ key: "text", label: "Message", kind: "textarea", placeholder: "Type the message…" }],
    outputs: () => SINGLE,
    summary: (d) => s(d.text) || "No text yet",
  },
  send_media: {
    label: "Send Media", group: "send",
    fields: [
      { key: "url", label: "Media URL", kind: "text", placeholder: "https://…" },
      { key: "caption", label: "Caption", kind: "text" },
    ],
    outputs: () => SINGLE,
    summary: (d) => s(d.caption) || s(d.url) || "No media yet",
  },
  send_buttons: {
    label: "Send Buttons", group: "send",
    fields: [
      { key: "text", label: "Message", kind: "textarea" },
      { key: "buttons", label: "Buttons (one per line, max 3)", kind: "list" },
    ],
    outputs: (d) => {
      const b = arr(d.buttons).slice(0, 3);
      return b.length ? b.map((label, i) => ({ id: `btn-${i}`, label })) : SINGLE;
    },
    summary: (d) => s(d.text) || `${arr(d.buttons).length} button(s)`,
  },
  send_list: {
    label: "Send List", group: "send",
    fields: [
      { key: "text", label: "Message", kind: "textarea" },
      { key: "items", label: "List items (one per line)", kind: "list" },
    ],
    outputs: () => SINGLE,
    summary: (d) => s(d.text) || `${arr(d.items).length} item(s)`,
  },
  send_template: {
    label: "Send Template", group: "send",
    fields: [
      { key: "templateName", label: "Template name", kind: "text" },
      { key: "language", label: "Language code", kind: "text", placeholder: "en" },
    ],
    outputs: () => SINGLE,
    summary: (d) => s(d.templateName) || "No template chosen",
  },

  // ── Ask Questions ──
  ...askSpec("ask_text", "Ask Text"),
  ...askSpec("ask_number", "Ask Number"),
  ...askSpec("ask_phone", "Ask Phone"),
  ...askSpec("ask_email", "Ask Email"),

  // ── Utilities ──
  condition: {
    label: "Condition", group: "utility",
    fields: [
      { key: "field", label: "Field", kind: "text", placeholder: "message_text" },
      { key: "op", label: "Operator", kind: "text", placeholder: "equals / contains / not_equals" },
      { key: "value", label: "Value", kind: "text" },
    ],
    outputs: () => [{ id: "true", label: "Yes" }, { id: "false", label: "No" }],
    summary: (d) => `${s(d.field) || "field"} ${s(d.op) || "?"} ${s(d.value)}`.trim(),
  },
  switch: {
    label: "Switch", group: "utility",
    fields: [
      { key: "field", label: "Field", kind: "text" },
      { key: "cases", label: "Cases (one value per line)", kind: "list" },
    ],
    outputs: (d) => {
      const c = arr(d.cases);
      return [...c.map((label, i) => ({ id: `case-${i}`, label })), { id: "default", label: "default" }];
    },
    summary: (d) => `${s(d.field) || "field"} → ${arr(d.cases).length} case(s)`,
  },
  delay: {
    label: "Delay", group: "utility",
    fields: [{ key: "seconds", label: "Delay (seconds)", kind: "number" }],
    outputs: () => SINGLE,
    summary: (d) => (d.seconds ? `Wait ${s(d.seconds)}s` : "No delay set"),
  },
  business_hours: {
    label: "Business Hours", group: "utility",
    fields: [
      { key: "open", label: "Open (HH:MM)", kind: "text", placeholder: "09:00" },
      { key: "close", label: "Close (HH:MM)", kind: "text", placeholder: "18:00" },
    ],
    outputs: () => [{ id: "inside", label: "Open" }, { id: "outside", label: "Closed" }],
    summary: (d) => (d.open || d.close ? `${s(d.open)}–${s(d.close)}` : "Set hours"),
  },
  jump_to: {
    label: "Jump To", group: "utility",
    fields: [{ key: "targetLabel", label: "Jump to node (name)", kind: "text" }],
    outputs: () => [],
    summary: (d) => (d.targetLabel ? `→ ${s(d.targetLabel)}` : "Pick a node"),
  },

  // ── Actions ──
  assign_tag: {
    label: "Assign Tag", group: "action",
    fields: [{ key: "tag", label: "Tag", kind: "text" }],
    outputs: () => SINGLE,
    summary: (d) => s(d.tag) || "No tag",
  },
  assign_label: {
    label: "Assign Label", group: "action",
    fields: [{ key: "label", label: "Label", kind: "text" }],
    outputs: () => SINGLE,
    summary: (d) => s(d.label) || "No label",
  },
};

function askSpec(type: string, label: string): Record<string, NodeSpec> {
  return {
    [type]: {
      label, group: "ask",
      fields: [
        { key: "prompt", label: "Question", kind: "textarea" },
        { key: "variable", label: "Save answer as", kind: "text", placeholder: "e.g. name" },
      ],
      outputs: () => SINGLE,
      summary: (d) => s(d.prompt) || "No question yet",
    },
  };
}

export function specFor(type: string): NodeSpec {
  return NODE_SPECS[type] ?? NODE_SPECS.send_text;
}
