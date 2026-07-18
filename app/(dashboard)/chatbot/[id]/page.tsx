import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import {
  asGraph,
  TRIGGER_EVENT_LABELS,
  type TriggerEvent,
  type FlowNode,
} from "@/lib/chatbotFlows";
import { FlowBuilder } from "@/components/flow/FlowBuilder";

export const dynamic = "force-dynamic";

// Chatbot flow builder (Phase 2). Loads the flow's graph and hands it to the React
// Flow canvas. Seeds a trigger start node for a brand-new (empty) flow.
export default async function ChatbotBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCapability("chatbot.manage");
  const { id } = await params;

  const flow = await prisma.chatbotFlow.findUnique({ where: { id } });
  if (!flow) notFound();

  const triggerLabel = TRIGGER_EVENT_LABELS[flow.triggerEvent as TriggerEvent] ?? flow.triggerEvent;
  const graph = asGraph(flow.graph);

  // Every flow starts from a single trigger node; seed one if the graph is empty.
  const nodes: FlowNode[] = graph.nodes.length
    ? graph.nodes
    : [{ id: "trigger", type: "trigger", position: { x: 250, y: 40 }, data: { label: triggerLabel } }];

  return (
    <div className="space-y-4">
      <FlowBuilder
        flowId={flow.id}
        name={flow.name}
        triggerLabel={triggerLabel}
        initialNodes={nodes}
        initialEdges={graph.edges}
      />
    </div>
  );
}
