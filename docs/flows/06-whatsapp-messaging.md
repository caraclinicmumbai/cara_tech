# Flow 6 — WhatsApp messaging

One continuous WhatsApp thread per patient, on one number, covering automated and
manual messages plus every inbound reply — so any agent can pick up where the last
left off (continuity across staff turnover).

## Design decision

Built **directly on the Meta WhatsApp Business Cloud API**, not a third-party BSP
(11za/DoubleTick). Rationale: a BSP _is_ the Cloud API plus a separate inbox; the
clinic needs one unified system inside Cara (full thread on the patient profile), and
the one-number-one-WABA rule means the same number must serve automated outreach and
manual follow-up.

## Inbound (patient → clinic)

1. **Webhook** `POST /api/webhooks/whatsapp` (verified via `META_APP_SECRET`).
2. Matches the sender to a lead by phone (last 10 digits). An **unknown number**
   auto-creates a lead (`findOrCreateLeadByPhone`, source `whatsapp`, manual queue,
   never auto-called) — except a `STOP` from an unknown number, which does not.
3. Stores the message on the thread (`Message`), updates delivery statuses by `waId`,
   pings Slack, and handles **`STOP`** as an opt-out (suppresses all outreach).
4. **Media** (scalp photos / reports) is stored by `mediaId` and rendered via a
   session-gated proxy (`/api/whatsapp/media/[mediaId]`) — Meta media expires (~30d),
   so it's fetched on demand rather than stored.

## Outbound (clinic → patient)

- **Inside the 24h customer-service window:** a free-form text from an agent
  (`sendLeadWhatsApp` server action) is sent and logged with the sending agent.
- **Outside the window:** only an **approved template** can re-open the chat. The lead
  page offers a template picker (`listApprovedTemplates`) that shows a **live preview of
  the message the patient will receive** and **pre-fills the body variables from the
  lead** (`lib/templateFill.ts` — name, treatment, clinic/branch, rep, guessed from the
  words before each `{{n}}`). The agent can overwrite any slot; sending is blocked while
  one is blank, because Meta rejects an empty parameter.
- **What the thread stores:** a template send is logged with its **rendered body** (the
  approved text with the variables filled in), not the template's internal name, so the
  chat reads as the patient read it. `Message.templateName` is kept alongside it and
  shown as a small chip on the bubble.
- **In-CRM template builder** (`/templates`): staff create/submit templates to Meta
  (`createTemplate`) and watch them move PENDING → APPROVED without leaving Cara.

## The WhatsApp tab (inbox)

`/whatsapp` is the inbox: every patient conversation in one place, laid out like
WhatsApp Web — chats down the left, the selected thread on the right. It exists so an
inbound reply reaches a counsellor as a **notification**, rather than waiting to be
found by opening leads one at a time.

- **The list** (`lib/whatsappInbox.ts` → `listConversations`) is one row per lead that
  has a thread, newest activity first: name, last-message preview ("You: …" when we
  sent it), WhatsApp-style timestamp (time today / "Yesterday" / date), unread count,
  whether the 24h window is open, and the owning counsellor.
- **Unread is per USER** (`ChatRead`, one row per user × lead). The clinic shares one
  number, but two counsellors working side by side each need their own sense of what's
  new — one opening a chat must not clear the other's badge. Opening a conversation
  marks it read up to that instant; a reply arriving in an already-open chat re-marks it.
- **Scope is the usual one**: a telecaller sees conversations for leads they own or
  cover, a manager sees all (`leadWhereForUser`). The lead id in `?lead=` is re-checked
  server-side, never trusted from the list.
- **The thread pane is the same `WhatsAppChat`** the lead page uses (`variant="fill"`),
  so the live SSE stream, 24h-window rules, template picker and delivery ticks are one
  implementation, not two.
- **The list polls** every 15s (paused while the tab is hidden, refreshed on focus)
  while the open thread streams; a new reply bumps its chat to the top and raises the
  badge without a reload. The sidebar tab carries the same unread total, server-rendered
  so it's right on first paint.

## Live thread (realtime)

The chat updates itself — an agent never reloads to see a reply.

1. Every write to a thread (inbound webhook, agent send, chatbot send, delivery receipt)
   goes through `lib/messages.ts`, which publishes the lead id on one Redis channel
   (`lib/realtime.ts`).
2. `GET /api/leads/[id]/messages/stream` is an **SSE** endpoint, session- and
   ownership-gated like the page. It wakes on the Redis nudge, reads rows newer than its
   cursor, and pushes them to the open chat window.
3. The cursor is `Message.updatedAt`, so **status ticks** (sent → delivered → read) stream
   too, not just new messages. It rides on the SSE `id:` field, which the browser replays
   as `Last-Event-ID` when it reconnects.
4. Redis is only a nudge: the stream also polls on a slow timer, so a Redis outage costs
   a few seconds of latency instead of breaking chat.

A patient's reply also **re-opens the composer live** — the client derives the 24h window
from the thread rather than the page's render-time snapshot.

## Automated outreach triggers (`lib/outreach.ts`)

Fired from `recordCall` (flow 3), each off unless its template env is set:

| Trigger | Env | When |
|---------|-----|------|
| New lead | `WHATSAPP_TEMPLATE_NEW_LEAD` | At intake (excl. duplicate/walk-in/held) |
| Confirmed | `WHATSAPP_TEMPLATE_CONFIRMED` | Call outcome `confirmed` |
| Unreachable | `WHATSAPP_TEMPLATE_UNREACHABLE` | Attempt ladder exhausted |
| Callback | `WHATSAPP_TEMPLATE_CALLBACK` | Callback scheduled ({{1}}=name, {{2}}=time) |

## Key files

- `lib/providers/whatsapp.ts` — Graph API send + media fetch; `isWhatsAppConfigured`
- `lib/messages.ts` — conversation service (record inbound, send text/template, 24h window)
- `lib/whatsappTemplates.ts` — list/create templates; render an approved body with its params
- `lib/templateFill.ts` — pre-fill a template's `{{n}}` variables from the lead
- `lib/realtime.ts` — Redis pub/sub nudge for the live thread
- `lib/whatsappInbox.ts` — conversation list, unread counts, read markers
- `app/(dashboard)/whatsapp/page.tsx` + `components/WhatsAppInbox.tsx` — the WhatsApp tab
- `app/api/whatsapp/conversations` — the list the tab polls
- `lib/outreach.ts` — automated trigger templates
- `app/api/webhooks/whatsapp/route.ts` — inbound webhook
- `app/api/leads/[id]/messages/stream/route.ts` — SSE live thread
- `components/WhatsAppChat.tsx` — thread + composer + template picker
- `app/(dashboard)/templates/page.tsx` — template builder
- `scripts/backfillTemplateBodies.ts` — one-off repair of legacy `[template] <name>` rows

## Configuration

| Env | Meaning |
|-----|---------|
| `WHATSAPP_TOKEN` | Permanent System User token |
| `WHATSAPP_PHONE_NUMBER_ID` | Sender phone number id |
| `WHATSAPP_WABA_ID` | WhatsApp Business Account id (templates) |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification handshake |
| `WHATSAPP_TEMPLATE_*` | Automated-outreach template names |

## Limitations

- **The app must be subscribed to the WABA** (`POST /{WABA_ID}/subscribed_apps`) for
  inbound to deliver — configuring the webhook in the dashboard alone is not enough.
  (This is set up in prod.)
- **Outside the 24h window, only approved templates can be sent.** Free-form replies
  fail until the patient messages again or a template re-opens the window.
- **Media URLs expire (~30 days).** Old images are re-fetched on demand and will 404 if
  Meta has expired them.
- **Automated triggers are off until each template is approved** and its name set in
  the env var.
- **Variable auto-fill is a best guess** from the words before each `{{n}}` — a slot with
  no clue in the wording (a date, an amount) is left blank for the agent to type.
- **Templates sent before this change** were logged as `[template] <name>`;
  `scripts/backfillTemplateBodies.ts` rewrites them with the approved body, but their
  parameter values were never recorded, so those bubbles still show `{{1}}`. A row whose
  template is no longer approved reads "Template message — text not recorded".
- **One number = one WABA.** This number is independent of any numbers on other BSPs
  (e.g. Zenoti/11za); they don't share threads.
