// Chatbot runtime (Phase 3). Executes a ChatbotFlow against inbound WhatsApp
// messages: on a matching trigger it starts a session and walks the node graph,
// pausing at "wait" nodes (ask / buttons / list) until the lead's next reply. All
// sends go out inside the 24h window (the inbound just opened it). Best-effort:
// never throws to the webhook.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asGraph, isFlowPriority, type FlowGraph, type FlowNode } from "@/lib/chatbotFlows";
import {
  sendLeadText,
  sendLeadButtons,
  sendLeadList,
  sendLeadImage,
  sendLeadTemplate,
} from "@/lib/messages";
import { logger } from "@/lib/logger";

const MAX_STEPS = 30; // loop/runaway guard per execution

export type ChatInput = {
  text: string;
  interactiveId?: string; // button/list reply id (e.g. "btn-1")
  interactiveTitle?: string; // button/list reply title
};

type Vars = Record<string, unknown>;
type Ctx = { leadId: string; leadName: string; leadPhone: string; vars: Vars };
type ExecResult = { pause?: "ask" | "buttons" | "list"; end?: boolean; handle?: string };

// ── Entry point ──────────────────────────────────────────────────────

/// Start or resume a chatbot flow for a lead's inbound message. No-op if the lead
/// opted out or nothing matches.
export async function runChatbot(leadId: string, input: ChatInput): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, name: true, phone: true, optedOut: true },
    });
    if (!lead || lead.optedOut) return;

    const session = await prisma.chatbotSession.findFirst({
      where: { leadId, status: "active" },
      orderBy: { updatedAt: "desc" },
    });

    if (session) {
      const flow = await prisma.chatbotFlow.findUnique({ where: { id: session.flowId } });
      if (flow && flow.active) {
        await resume(session.id, asGraph(flow.graph), session, lead, input);
        return;
      }
      // Flow gone/disabled — end this session and fall through to maybe start a new one.
      await prisma.chatbotSession.update({ where: { id: session.id }, data: { status: "ended" } });
    }

    await start(lead, input);
  } catch (err) {
    logger.error(`Chatbot runtime error for lead ${leadId}: ${String(err)}`);
  }
}

// ── Stage-change trigger (proactive, §matrix) ────────────────────────

/// Fire a chatbot flow when a lead's pipeline stage changes. Picks the best
/// matching active `stage_change` flow using the (stage × campaign) matrix:
/// a flow targeting BOTH the stage and the lead's latest campaign beats a
/// stage-only catch-all; priority then recency break ties. Skipped if the lead
/// opted out or is already mid-conversation (won't interrupt an active session).
///
/// NOTE: this is business-initiated — outside WhatsApp's 24h window the first
/// message must be a template, so such flows should start with a Send Template node.
export async function runStageChange(leadId: string, newStage: string): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, name: true, phone: true, optedOut: true, campaign: true },
    });
    if (!lead || lead.optedOut) return;

    const active = await prisma.chatbotSession.findFirst({
      where: { leadId, status: "active" },
      select: { id: true },
    });
    if (active) return; // don't talk over an ongoing conversation

    const now = new Date();
    const flows = await prisma.chatbotFlow.findMany({
      where: { active: true, triggerEvent: "stage_change", OR: [{ expireOn: null }, { expireOn: { gt: now } }] },
    });

    const leadCampaign = lead.campaign ?? "";
    const candidates = flows
      .map((f) => {
        const cfg = (f.triggerConfig && typeof f.triggerConfig === "object" ? f.triggerConfig : {}) as {
          stage?: string;
          campaign?: string;
        };
        const stageOk = !cfg.stage || cfg.stage === newStage;
        const campSpecified = !!cfg.campaign;
        const campOk = !campSpecified || cfg.campaign === leadCampaign;
        if (!stageOk || !campOk) return null;
        // Most-specific wins: campaign-matched (+2) beats stage-only; exact stage (+1).
        const specificity = (cfg.stage === newStage ? 1 : 0) + (campSpecified ? 2 : 0);
        return { f, specificity };
      })
      .filter((x): x is { f: (typeof flows)[number]; specificity: number } => x !== null);

    if (candidates.length === 0) return;
    candidates.sort(
      (a, b) =>
        b.specificity - a.specificity ||
        priorityRank(b.f.priority) - priorityRank(a.f.priority) ||
        +b.f.updatedAt - +a.f.updatedAt,
    );
    const flow = candidates[0].f;

    const graph = asGraph(flow.graph);
    const trigger = graph.nodes.find((n) => n.type === "trigger") ?? graph.nodes[0];
    if (!trigger) return;
    const firstId = nextTarget(graph, trigger.id, "out");
    if (!firstId) return;

    const vars: Vars = { stage: newStage, campaign: leadCampaign, message_text: "" };
    const session = await prisma.chatbotSession.create({
      data: { leadId: lead.id, flowId: flow.id, status: "active", variables: vars as Prisma.InputJsonValue },
    });
    logger.info(`Chatbot stage-change flow "${flow.name}" started for lead ${lead.id} (stage ${newStage})`);
    await walk(session.id, graph, firstId, { leadId: lead.id, leadName: lead.name, leadPhone: lead.phone, vars });
  } catch (err) {
    logger.error(`Chatbot stage-change error for lead ${leadId}: ${String(err)}`);
  }
}

// ── Start a new flow ─────────────────────────────────────────────────

async function start(
  lead: { id: string; name: string; phone: string },
  input: ChatInput,
): Promise<void> {
  const now = new Date();
  const flows = await prisma.chatbotFlow.findMany({
    where: { active: true, OR: [{ expireOn: null }, { expireOn: { gt: now } }] },
  });
  if (flows.length === 0) return;

  const inboundCount = await prisma.message.count({ where: { leadId: lead.id, direction: "inbound" } });
  const isFirstInbound = inboundCount <= 1; // this inbound already stored

  const matched = flows
    .filter((f) => matchTrigger(f.triggerEvent, f.triggerConfig, input.text, isFirstInbound))
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || +b.updatedAt - +a.updatedAt);
  const flow = matched[0];
  if (!flow) return;

  const graph = asGraph(flow.graph);
  const trigger = graph.nodes.find((n) => n.type === "trigger") ?? graph.nodes[0];
  if (!trigger) return;
  const firstId = nextTarget(graph, trigger.id, "out");
  if (!firstId) return;

  const vars: Vars = { message_text: input.text };
  const session = await prisma.chatbotSession.create({
    data: { leadId: lead.id, flowId: flow.id, status: "active", variables: vars as Prisma.InputJsonValue },
  });
  logger.info(`Chatbot flow "${flow.name}" started for lead ${lead.id}`);
  await walk(session.id, graph, firstId, { leadId: lead.id, leadName: lead.name, leadPhone: lead.phone, vars });
}

// ── Resume a paused session ──────────────────────────────────────────

async function resume(
  sessionId: string,
  graph: FlowGraph,
  session: { currentNodeId: string | null; waitKind: string | null; variables: unknown },
  lead: { id: string; name: string; phone: string },
  input: ChatInput,
): Promise<void> {
  const vars: Vars = { ...(typeof session.variables === "object" && session.variables ? (session.variables as Vars) : {}) };
  vars.message_text = input.text;
  const node = graph.nodes.find((n) => n.id === session.currentNodeId);
  if (!node) {
    await prisma.chatbotSession.update({ where: { id: sessionId }, data: { status: "ended" } });
    return;
  }

  let handle = "out";
  if (session.waitKind === "ask") {
    const varName = str(node.data.variable) || node.id;
    vars[varName] = input.text;
  } else if (session.waitKind === "buttons") {
    // The tapped button id (btn-i) picks the branch; fall back to title match.
    handle = input.interactiveId || matchButtonHandle(node, input.interactiveTitle || input.text) || "out";
  } else if (session.waitKind === "list") {
    const varName = str(node.data.variable) || node.id;
    vars[varName] = input.interactiveTitle || input.text;
  }

  const nextId = nextTarget(graph, node.id, handle);
  const ctx: Ctx = { leadId: lead.id, leadName: lead.name, leadPhone: lead.phone, vars };
  if (!nextId) {
    await endSession(sessionId, vars);
    return;
  }
  await walk(sessionId, graph, nextId, ctx);
}

// ── Walk the graph ───────────────────────────────────────────────────

async function walk(sessionId: string, graph: FlowGraph, startId: string, ctx: Ctx): Promise<void> {
  let currentId: string | null = startId;
  let steps = 0;
  while (currentId && steps < MAX_STEPS) {
    steps++;
    const node: FlowNode | undefined = graph.nodes.find((n) => n.id === currentId);
    if (!node) break;

    const res = await execNode(node, ctx);
    if (res.pause) {
      await prisma.chatbotSession.update({
        where: { id: sessionId },
        data: { currentNodeId: node.id, waitKind: res.pause, variables: ctx.vars as Prisma.InputJsonValue, status: "active" },
      });
      return;
    }
    if (res.end) break;
    currentId = nextTarget(graph, node.id, res.handle ?? "out");
  }
  await endSession(sessionId, ctx.vars);
}

async function endSession(sessionId: string, vars: Vars): Promise<void> {
  await prisma.chatbotSession.update({
    where: { id: sessionId },
    data: { status: "ended", currentNodeId: null, waitKind: null, variables: vars as Prisma.InputJsonValue },
  });
}

// ── Node executors ───────────────────────────────────────────────────

async function execNode(node: FlowNode, ctx: Ctx): Promise<ExecResult> {
  const d = node.data ?? {};
  const opts = { automated: true as const };
  switch (node.type) {
    case "send_text": {
      const text = interpolate(str(d.text), ctx);
      if (text) await sendLeadText(ctx.leadId, text, opts);
      return { handle: "out" };
    }
    case "send_media": {
      const url = str(d.url);
      if (url) await sendLeadImage(ctx.leadId, url, interpolate(str(d.caption), ctx) || undefined, opts);
      return { handle: "out" };
    }
    case "send_template": {
      const name = str(d.templateName);
      if (name) await sendLeadTemplate(ctx.leadId, name, str(d.language) || "en", undefined, opts);
      return { handle: "out" };
    }
    case "send_buttons": {
      const buttons = list(d.buttons).slice(0, 3).map((title, i) => ({ id: `btn-${i}`, title }));
      const text = interpolate(str(d.text), ctx) || "Please choose:";
      if (buttons.length) {
        await sendLeadButtons(ctx.leadId, text, buttons, opts);
        return { pause: "buttons" };
      }
      if (text) await sendLeadText(ctx.leadId, text, opts);
      return { handle: "out" };
    }
    case "send_list": {
      const rows = list(d.items).slice(0, 10).map((title, i) => ({ id: `row-${i}`, title }));
      const text = interpolate(str(d.text), ctx) || "Please choose:";
      if (rows.length) {
        await sendLeadList(ctx.leadId, text, "Choose", rows, opts);
        return { pause: "list" };
      }
      if (text) await sendLeadText(ctx.leadId, text, opts);
      return { handle: "out" };
    }
    case "ask_text":
    case "ask_number":
    case "ask_phone":
    case "ask_email": {
      const prompt = interpolate(str(d.prompt), ctx);
      if (prompt) await sendLeadText(ctx.leadId, prompt, opts);
      return { pause: "ask" };
    }
    case "condition": {
      const ok = evaluate(resolveField(str(d.field), ctx), str(d.op), str(d.value));
      return { handle: ok ? "true" : "false" };
    }
    case "switch": {
      const val = String(resolveField(str(d.field), ctx) ?? "").toLowerCase();
      const cases = list(d.cases);
      const idx = cases.findIndex((c) => c.toLowerCase() === val);
      return { handle: idx >= 0 ? `case-${idx}` : "default" };
    }
    case "business_hours": {
      return { handle: withinBusinessHours(str(d.open), str(d.close)) ? "inside" : "outside" };
    }
    case "delay":
      // v1: not enforced (immediate). Real delays need a scheduled resume (later).
      return { handle: "out" };
    case "assign_tag": {
      const tag = interpolate(str(d.tag), ctx);
      if (tag) await prisma.lead.update({ where: { id: ctx.leadId }, data: { tag } }).catch(() => {});
      return { handle: "out" };
    }
    case "assign_label":
      // v1: no label store yet — no-op, continue.
      return { handle: "out" };
    case "jump_to":
      // v1: jump-by-name not resolved — end the branch gracefully.
      return { end: true };
    default:
      return { end: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}
function priorityRank(p: string): number {
  return isFlowPriority(p) ? { high: 3, medium: 2, low: 1 }[p] : 0;
}

/// Follow the edge out of `nodeId` on `handle`. Exact handle match first; for the
/// default "out" handle also accept edges with no explicit sourceHandle.
function nextTarget(graph: FlowGraph, nodeId: string, handle: string): string | null {
  let e = graph.edges.find((ed) => ed.source === nodeId && ed.sourceHandle === handle);
  if (!e && handle === "out") {
    e = graph.edges.find((ed) => ed.source === nodeId && (ed.sourceHandle == null || ed.sourceHandle === "out"));
  }
  return e?.target ?? null;
}

function matchButtonHandle(node: FlowNode, title: string): string | null {
  const buttons = list((node.data ?? {}).buttons);
  const i = buttons.findIndex((b) => b.toLowerCase() === title.trim().toLowerCase());
  return i >= 0 ? `btn-${i}` : null;
}

/// {{key}} → session var, else lead name/phone, else "".
function interpolate(text: string, ctx: Ctx): string {
  if (!text.includes("{{")) return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key in ctx.vars) return str(ctx.vars[key]);
    if (key === "name") return ctx.leadName;
    if (key === "phone") return ctx.leadPhone;
    return "";
  });
}

/// Resolve a condition/switch field: "message_text" and any collected variable come
/// from vars; "name"/"phone" from the lead.
function resolveField(field: string, ctx: Ctx): unknown {
  if (!field) return "";
  if (field in ctx.vars) return ctx.vars[field];
  if (field === "name") return ctx.leadName;
  if (field === "phone") return ctx.leadPhone;
  return "";
}

function evaluate(a: unknown, op: string, value: string): boolean {
  const A = String(a ?? "").trim().toLowerCase();
  const V = value.trim().toLowerCase();
  switch (op.trim().toLowerCase()) {
    case "equals": return A === V;
    case "not_equals": return A !== V;
    case "contains": return A.includes(V);
    case "not_contains": return !A.includes(V);
    case "starts_with": return A.startsWith(V);
    case "ends_with": return A.endsWith(V);
    case "is_empty": return A === "";
    case "is_not_empty": return A !== "";
    default: return A === V; // sensible default
  }
}

/// IST business-hours check (HH:MM). Empty/invalid → treat as inside.
function withinBusinessHours(open: string, close: string): boolean {
  const parse = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const o = parse(open), c = parse(close);
  if (o == null || c == null) return true;
  const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = nowIst.getHours() * 60 + nowIst.getMinutes();
  return o <= c ? mins >= o && mins < c : mins >= o || mins < c;
}

/// Does this flow's trigger fire for the inbound text?
function matchTrigger(triggerEvent: string, triggerConfig: unknown, text: string, isFirstInbound: boolean): boolean {
  const cfg = (triggerConfig && typeof triggerConfig === "object" ? triggerConfig : {}) as Record<string, unknown>;
  switch (triggerEvent) {
    case "welcome":
      return isFirstInbound;
    case "keyword": {
      const kw = str(cfg.value ?? cfg.keyword);
      return kw ? text.toLowerCase().includes(kw.toLowerCase()) : false;
    }
    case "inbound_message":
    case "template_message":
      if (cfg.field && cfg.op) {
        return evaluate(text, str(cfg.op), str(cfg.value));
      }
      return true;
    default:
      return false;
  }
}
