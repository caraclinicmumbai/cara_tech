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
  page offers a template picker (`listApprovedTemplates`) with body-variable inputs.
- **In-CRM template builder** (`/templates`): staff create/submit templates to Meta
  (`createTemplate`) and watch them move PENDING → APPROVED without leaving Cara.

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
- `lib/whatsappTemplates.ts` — list/create templates
- `lib/outreach.ts` — automated trigger templates
- `app/api/webhooks/whatsapp/route.ts` — inbound webhook
- `app/(dashboard)/templates/page.tsx` — template builder

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
- **One number = one WABA.** This number is independent of any numbers on other BSPs
  (e.g. Zenoti/11za); they don't share threads.
