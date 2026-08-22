// Live WhatsApp thread for one lead (§3.1.3 realtime), over Server-Sent Events.
//
// The lead page renders the thread server-side; this stream keeps it current
// without the agent reloading — an inbound reply, a chatbot send, or a delivery
// receipt shows up in the open chat window straight away.
//
// Two wake-up sources, deliberately:
//   1. a Redis pub/sub nudge published by lib/messages.ts on every write (instant);
//   2. a slow poll, so a Redis outage degrades latency instead of breaking chat.
// Both paths do the same thing — read rows newer than the cursor and push them.
//
// The cursor is Message.updatedAt (not createdAt) so a status change on an
// already-sent message is delivered too. Each event carries its cursor as the
// SSE `id:`, which the browser replays as Last-Event-ID when it reconnects.
import { prisma } from "@/lib/prisma";
import { currentUser, userCanAccessLead } from "@/lib/authz";
import { subscribeLeadMessages } from "@/lib/realtime";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const POLL_MS = 8_000; // safety net when the Redis nudge doesn't arrive
const HEARTBEAT_MS = 20_000; // keep proxies from closing an idle connection
const MAX_LIFETIME_MS = 10 * 60_000; // recycle the connection; EventSource reconnects
const BATCH = 100;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { id: leadId } = await ctx.params;
  // Ownership scope, same rule as the page: not visible → not found.
  if (!(await userCanAccessLead(user, leadId))) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  // Prefer the browser's replayed cursor over the one baked into the URL at mount.
  const lastEventId = req.headers.get("last-event-id");
  const sinceParam = lastEventId ?? url.searchParams.get("since");
  const parsed = sinceParam ? new Date(sinceParam) : null;
  let cursor = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let wake: (() => void) | null = null;
      let unsubscribe: (() => void) | null = null;
      const startedAt = Date.now();

      /// Enqueue, tolerating the client having gone away mid-write.
      function write(chunk: string): boolean {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      }

      function close() {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        wake?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      req.signal.addEventListener("abort", close);

      // Nudges are broadcast on one channel for all leads — ignore other leads'.
      unsubscribe = await subscribeLeadMessages((changedLeadId) => {
        if (changedLeadId === leadId) wake?.();
      });

      write(`retry: 3000\n\n`);

      let lastBeat = Date.now();
      while (!closed) {
        try {
          const rows = await prisma.message.findMany({
            where: { leadId, updatedAt: { gt: cursor } },
            orderBy: { updatedAt: "asc" },
            take: BATCH,
          });

          if (rows.length > 0) {
            cursor = rows[rows.length - 1].updatedAt;
            const payload = rows.map((m) => ({
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
            }));
            if (!write(`id: ${cursor.toISOString()}\nevent: messages\ndata: ${JSON.stringify(payload)}\n\n`)) break;
            lastBeat = Date.now();
            // More than a batch behind (a long backlog) — drain without waiting.
            if (rows.length === BATCH) continue;
          } else if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            if (!write(`: ping\n\n`)) break;
            lastBeat = Date.now();
          }
        } catch (err) {
          logger.error(`Lead ${leadId} message stream query failed: ${String(err)}`);
        }

        if (Date.now() - startedAt > MAX_LIFETIME_MS) break;

        // Sleep until the next nudge, the poll tick, or a disconnect.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, POLL_MS);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }

      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx and friends) — otherwise events pool.
      "X-Accel-Buffering": "no",
    },
  });
}
