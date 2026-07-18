import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { asGraph, TRIGGER_EVENT_LABELS, type TriggerEvent } from "@/lib/chatbotFlows";

export const dynamic = "force-dynamic";

// Chatbot flow builder (Phase 2b). Placeholder for now — the visual React Flow
// canvas lands in the next phase. Shows the flow's basics so the route is live.
export default async function ChatbotBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCapability("chatbot.manage");
  const { id } = await params;

  const flow = await prisma.chatbotFlow.findUnique({ where: { id } });
  if (!flow) notFound();

  const graph = asGraph(flow.graph);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/chatbot" className="text-sm text-black/50 hover:underline dark:text-white/50">
          ← Chatbot flows
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{flow.name}</h1>
        <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">
          {TRIGGER_EVENT_LABELS[flow.triggerEvent as TriggerEvent] ?? flow.triggerEvent}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            flow.active
              ? "bg-green-600/15 text-green-700 dark:text-green-400"
              : "bg-black/10 text-black/50 dark:bg-white/10 dark:text-white/50"
          }`}
        >
          {flow.active ? "On" : "Off"}
        </span>
      </div>

      <div className="rounded-lg border border-dashed border-black/20 p-10 text-center dark:border-white/20">
        <p className="text-sm text-black/60 dark:text-white/60">
          🧩 Visual flow builder — coming in the next phase.
        </p>
        <p className="mt-1 text-xs text-black/40 dark:text-white/40">
          {graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"}, {graph.edges.length} connection
          {graph.edges.length === 1 ? "" : "s"} saved.
        </p>
      </div>
    </div>
  );
}
