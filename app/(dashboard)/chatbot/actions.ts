"use server";

// Server Actions for chatbot flows (Phase 2 — chatbot builder). All gated on
// `chatbot.manage` (Branch Manager / CRM Admin). The flow graph itself is edited in
// the builder (Phase 2b); these handle the list-level lifecycle.
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import {
  isTriggerEvent,
  isFlowPriority,
  asGraph,
  EMPTY_GRAPH,
} from "@/lib/chatbotFlows";
import { logger } from "@/lib/logger";

type Result = { ok: boolean; error?: string; id?: string };

const NAME_MAX = 80;

export async function createFlow(input: {
  name: string;
  triggerEvent?: string;
  priority?: string;
}): Promise<Result> {
  const user = await requireCapability("chatbot.manage");
  const name = (input.name ?? "").trim().slice(0, NAME_MAX);
  if (!name) return { ok: false, error: "Flow name is required" };
  const triggerEvent = input.triggerEvent && isTriggerEvent(input.triggerEvent) ? input.triggerEvent : "inbound_message";
  const priority = input.priority && isFlowPriority(input.priority) ? input.priority : "high";

  const flow = await prisma.chatbotFlow.create({
    data: {
      name,
      triggerEvent,
      priority,
      active: false,
      graph: EMPTY_GRAPH as unknown as Prisma.InputJsonValue,
      createdById: user.id,
    },
    select: { id: true },
  });
  logger.info(`Chatbot flow "${name}" created by ${user.email ?? "?"}`);
  revalidatePath("/chatbot");
  return { ok: true, id: flow.id };
}

export async function renameFlow(id: string, name: string): Promise<Result> {
  await requireCapability("chatbot.manage");
  const trimmed = name.trim().slice(0, NAME_MAX);
  if (!trimmed) return { ok: false, error: "Name is required" };
  await prisma.chatbotFlow.update({ where: { id }, data: { name: trimmed } });
  revalidatePath("/chatbot");
  return { ok: true };
}

export async function setFlowActive(id: string, active: boolean): Promise<Result> {
  await requireCapability("chatbot.manage");
  await prisma.chatbotFlow.update({ where: { id }, data: { active } });
  revalidatePath("/chatbot");
  return { ok: true };
}

export async function setFlowPriority(id: string, priority: string): Promise<Result> {
  await requireCapability("chatbot.manage");
  if (!isFlowPriority(priority)) return { ok: false, error: "Invalid priority" };
  await prisma.chatbotFlow.update({ where: { id }, data: { priority } });
  revalidatePath("/chatbot");
  return { ok: true };
}

export async function setFlowTrigger(id: string, triggerEvent: string): Promise<Result> {
  await requireCapability("chatbot.manage");
  if (!isTriggerEvent(triggerEvent)) return { ok: false, error: "Invalid trigger event" };
  await prisma.chatbotFlow.update({ where: { id }, data: { triggerEvent } });
  revalidatePath("/chatbot");
  return { ok: true };
}

/// Set the trigger matching config — for `stage_change` flows this is the target
/// stage + optional campaign (the matrix). Stored on ChatbotFlow.triggerConfig.
export async function setFlowTriggerConfig(
  id: string,
  config: { stage?: string; campaign?: string },
): Promise<Result> {
  await requireCapability("chatbot.manage");
  const clean = {
    stage: config.stage?.trim() || undefined,
    campaign: config.campaign?.trim() || undefined,
  };
  await prisma.chatbotFlow.update({
    where: { id },
    data: { triggerConfig: clean as Prisma.InputJsonValue },
  });
  revalidatePath("/chatbot");
  return { ok: true };
}

/// Duplicate a flow (name + " (copy)"), inactive, graph copied verbatim.
export async function duplicateFlow(id: string): Promise<Result> {
  const user = await requireCapability("chatbot.manage");
  const src = await prisma.chatbotFlow.findUnique({ where: { id } });
  if (!src) return { ok: false, error: "Flow not found" };
  const copy = await prisma.chatbotFlow.create({
    data: {
      name: `${src.name} (copy)`.slice(0, NAME_MAX),
      triggerEvent: src.triggerEvent,
      triggerConfig: src.triggerConfig ?? undefined,
      priority: src.priority,
      active: false,
      graph: asGraph(src.graph) as unknown as Prisma.InputJsonValue,
      createdById: user.id,
    },
    select: { id: true },
  });
  revalidatePath("/chatbot");
  return { ok: true, id: copy.id };
}

/// Persist the flow graph (nodes + edges) from the builder. Coerced through asGraph
/// so only the expected shape is stored.
export async function saveFlowGraph(
  id: string,
  graph: { nodes: unknown[]; edges: unknown[] },
): Promise<Result> {
  await requireCapability("chatbot.manage");
  const clean = asGraph(graph);
  await prisma.chatbotFlow.update({
    where: { id },
    data: { graph: clean as unknown as Prisma.InputJsonValue },
  });
  revalidatePath(`/chatbot/${id}`);
  revalidatePath("/chatbot");
  return { ok: true };
}

export async function deleteFlow(id: string): Promise<Result> {
  const user = await requireCapability("chatbot.manage");
  await prisma.chatbotFlow.delete({ where: { id } });
  logger.info(`Chatbot flow ${id} deleted by ${user.email ?? "?"}`);
  revalidatePath("/chatbot");
  return { ok: true };
}
