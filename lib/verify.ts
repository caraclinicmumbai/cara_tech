// Shared-secret verification for inbound webhooks. (Guide §9, §10 WEBHOOK_SECRET)
// n8n / ElevenLabs callbacks must send `x-webhook-secret: <WEBHOOK_SECRET>`.
export function verifyWebhookSecret(req: Request): boolean {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return false; // fail closed if unconfigured
  const got = req.headers.get("x-webhook-secret");
  return got === expected;
}
