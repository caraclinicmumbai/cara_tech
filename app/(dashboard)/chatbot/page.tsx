import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { ChatbotList } from "@/components/ChatbotList";

export const dynamic = "force-dynamic";

// Chatbot flows list (Phase 2 — chatbot builder). Route-guarded to `chatbot.manage`
// in the proxy; re-checked here for defense in depth. The visual builder lives at
// /chatbot/[id] (Phase 2b).
export default async function ChatbotPage() {
  await requireCapability("chatbot.manage");

  const flows = await prisma.chatbotFlow.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      triggerEvent: true,
      triggerConfig: true,
      priority: true,
      active: true,
      expireOn: true,
      updatedAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Chatbot</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          Build automated WhatsApp reply flows. Each flow runs on a trigger and walks
          its steps — send messages, ask questions, branch, and assign.
        </p>
      </div>
      <ChatbotList
        flows={flows.map((f) => {
          const cfg = (f.triggerConfig && typeof f.triggerConfig === "object" ? f.triggerConfig : {}) as {
            stage?: string;
            campaign?: string;
          };
          return {
            id: f.id,
            name: f.name,
            triggerEvent: f.triggerEvent,
            triggerStage: cfg.stage ?? "",
            triggerCampaign: cfg.campaign ?? "",
            priority: f.priority,
            active: f.active,
            expireOn: f.expireOn ? f.expireOn.toISOString() : null,
          };
        })}
      />
    </div>
  );
}
