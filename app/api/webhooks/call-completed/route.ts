// ElevenLabs post-call webhook (direct from ElevenLabs). (Guide §5, §7.2)
// Verifies the ElevenLabs HMAC signature, maps the payload, and records the call
// via the shared pipeline. If you route post-call data through n8n Agent 2
// instead, that path POSTs to /api/calls (x-webhook-secret) — same recordCall().
import { NextResponse } from "next/server";
import { elevenLabsPostCallSchema } from "@/lib/contracts";
import { verifyElevenLabsSignature, mapElevenLabsPostCall } from "@/lib/providers/elevenlabs";
import { recordCall } from "@/lib/callIntake";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  // Raw body first — the signature is computed over exact bytes.
  const raw = await req.text();
  if (!verifyElevenLabsSignature(raw, req.headers.get("elevenlabs-signature"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = elevenLabsPostCallSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const mapped = mapElevenLabsPostCall(parsed.data);
  if (!mapped) {
    logger.error("ElevenLabs post-call missing lead_id dynamic variable — ignoring");
    return NextResponse.json({ error: "Missing lead_id" }, { status: 400 });
  }

  const result = await recordCall(mapped);
  if (!result.ok) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }
  return NextResponse.json({ callId: result.call.id }, { status: 201 });
}
