// Call data CRUD. (Guide §5: app/api/calls/route.ts; contract §7.3)
// n8n Agent 2 POSTs processed call data here. We store the Call, update the
// Lead's status, and — after an INITIAL call — schedule the re-confirmation.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeCallSchema } from "@/lib/contracts";
import { recordCall } from "@/lib/callIntake";
import { verifyWebhookSecret } from "@/lib/verify";

export async function GET() {
  const calls = await prisma.call.findMany({
    orderBy: { createdAt: "desc" },
    include: { lead: true },
  });
  return NextResponse.json(calls);
}

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = writeCallSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const result = await recordCall(parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }
  return NextResponse.json(result.call, { status: 201 });
}
