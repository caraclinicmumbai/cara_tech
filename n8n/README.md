# n8n Workflows — Cara Clinic Call Flow

Two importable workflows that glue the CRM ↔ ElevenLabs (Build Guide §2.6).

```
CRM (lead created / re-confirm)
   │  POST N8N_WEBHOOK_NEW_LEAD  { leadId, name, phone, interest, callType, context }
   ▼
Agent 1 — Outbound Call  ──► ElevenLabs outbound-call API  ──► AI voice call
                                                                   │ (call ends)
                                                                   ▼
                                          ElevenLabs post-call webhook
                                                                   │
   ┌───────────────────────────────────────────────────────────────┘
   ▼
Agent 2 — Data Write  ──►  POST CRM /api/calls  { leadId, callType, transcript, outcome, ... }
                              └► recordCall(): stores call, updates status, schedules re-confirmation
```

## Import

In n8n: **Workflows → Import from File** → pick each JSON.

- `agent1-outbound-call.json`
- `agent2-data-write.json`

## Agent 1 — Outbound Call

1. Open **Call ElevenLabs** and replace:
   - `REPLACE_WITH_AGENT_ID` → your `ELEVENLABS_AGENT_ID`
   - `REPLACE_WITH_AGENT_PHONE_NUMBER_ID` → your `ELEVENLABS_AGENT_PHONE_NUMBER_ID`
   - header `xi-api-key` value `REPLACE_WITH_ELEVENLABS_API_KEY` → your key
     *(production: store as an n8n credential instead of inline)*
2. Activate, then copy the **Production** webhook URL of **Webhook — New Lead**
   into the CRM env `N8N_WEBHOOK_NEW_LEAD`.
3. `lead_id` + `call_type` are passed as ElevenLabs `dynamic_variables`, so they
   come back in the post-call webhook for correlation.

`sip_trunk` instead of Twilio? Change the URL to
`https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call`.

## Agent 2 — Data Write

1. In **POST to CRM** set the URL to `https://<your-crm>/api/calls` and the
   `x-webhook-secret` header to the CRM `WEBHOOK_SECRET`.
2. Activate, then set the **Production** webhook URL of **Webhook — Post-Call**
   as the ElevenLabs agent's **post-call webhook**.
3. Best outcomes: configure the ElevenLabs agent to **collect** data points
   `outcome` (confirmed | no_answer | rescheduled | not_interested) and
   `sentiment` (positive | neutral | negative). The **Map Call Data** node reads
   `data.analysis.data_collection_results.{outcome,sentiment}.value` and falls
   back to `call_successful` when they're absent.

## Don't want Agent 2?

Point the ElevenLabs post-call webhook directly at the CRM's
`POST /api/webhooks/call-completed`. It verifies the `ElevenLabs-Signature`
HMAC (`ELEVENLABS_WEBHOOK_SECRET`) and runs the same `recordCall()` pipeline —
one fewer moving part, at the cost of doing the mapping in app code instead of n8n.
