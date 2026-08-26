// The WhatsApp tab (§whatsapp inbox) — every patient conversation in one place,
// laid out like WhatsApp Web: chats down the left, the selected thread on the
// right. It's the notification surface for inbound WhatsApp, so a lead reaches a
// counsellor here without anyone hunting through the lead list.
//
// The thread itself is the same component the lead page uses — one implementation
// of the conversation, with its live stream, 24h-window rules and template picker.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { currentUser, canSeeLead } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { ensurePermissions } from "@/lib/permissions";
import { isServiceWindowOpen } from "@/lib/messages";
import { listConversations } from "@/lib/whatsappInbox";
import { WhatsAppInbox } from "@/components/WhatsAppInbox";
import { WhatsAppChat } from "@/components/WhatsAppChat";
import { NO_ACCESS_PATH } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function WhatsAppPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const viewer = await currentUser();
  if (!viewer) notFound();
  await ensurePermissions();
  if (!can(viewer.role, "leads.whatsapp")) redirect(NO_ACCESS_PATH);

  const { lead: selectedId } = await searchParams;
  const conversations = await listConversations(viewer);

  // The selected thread, when one is open. Ownership is re-checked here rather than
  // trusted from the list — the id arrives in the URL.
  const lead = selectedId
    ? await prisma.lead.findUnique({
        where: { id: selectedId },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
          assignedRep: { select: { name: true } },
          branch: { select: { name: true } },
          accessGrants: {
            where: { revokedAt: null },
            select: { granteeId: true, revokedAt: true, expiresAt: true },
          },
        },
      })
    : null;
  const visible = lead && canSeeLead(viewer, lead) ? lead : null;
  const windowOpen = visible ? await isServiceWindowOpen(visible.id) : false;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[1.5px] text-cara-muted">Inbox</p>
          <h1 className="text-2xl font-bold tracking-tight">WhatsApp</h1>
        </div>
        <p className="text-xs text-cara-muted">
          {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="grid h-[calc(100vh-13rem)] grid-cols-1 overflow-hidden rounded-xl border-[0.5px] border-cara-rule md:grid-cols-[20rem_1fr]">
        <aside className="min-h-0 border-b-[0.5px] border-cara-rule md:border-b-0 md:border-r-[0.5px]">
          <WhatsAppInbox initial={conversations} selectedLeadId={visible?.id ?? null} />
        </aside>

        <section className="flex min-h-0 flex-col">
          {!visible ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div className="space-y-2">
                <div className="text-4xl">💬</div>
                <p className="text-sm font-medium">Select a chat</p>
                <p className="max-w-xs text-xs text-cara-muted">
                  Every WhatsApp conversation with a patient lands here. Pick one on the left to
                  read it and reply.
                </p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-cara-rule px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">{visible.name}</h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        windowOpen
                          ? "bg-green-600/15 text-green-700 dark:text-green-400"
                          : "bg-black/5 text-black/50 dark:bg-white/10 dark:text-white/50"
                      }`}
                    >
                      {windowOpen ? "24h window open" : "window closed"}
                    </span>
                  </div>
                  <p className="truncate text-xs text-cara-muted">
                    {visible.phone}
                    {visible.assignedRep?.name ? ` · ${visible.assignedRep.name}` : ""}
                  </p>
                </div>
                <Link
                  href={`/leads/${visible.id}`}
                  className="shrink-0 rounded-lg border-[0.5px] border-cara-rule px-3 py-1.5 text-xs hover:bg-cara-surface"
                >
                  Open lead
                </Link>
              </header>

              <div className="min-h-0 flex-1">
                <WhatsAppChat
                  key={visible.id}
                  variant="fill"
                  leadId={visible.id}
                  windowOpen={windowOpen}
                  optedOut={visible.optedOut}
                  leadContext={{
                    name: visible.name,
                    phone: visible.phone,
                    interest: visible.interest,
                    treatment: visible.tag,
                    repName: visible.assignedRep?.name ?? null,
                    branchName: visible.branch?.name ?? null,
                    clinicName: process.env.CLINIC_NAME ?? "Cara Clinic",
                  }}
                  messages={visible.messages.map((m) => ({
                    id: m.id,
                    direction: m.direction,
                    type: m.type,
                    body: m.body,
                    mediaId: m.mediaId,
                    templateName: m.templateName,
                    status: m.status,
                    sentBy: m.sentBy,
                    automated: m.automated,
                    createdAt: m.createdAt.toISOString(),
                    updatedAt: m.updatedAt.toISOString(),
                  }))}
                />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
