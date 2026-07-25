// Record-view logging (§compliance) — "log every time someone LOOKS at a record".
// The lead page posts here on open; we record who, which lead, when, from what IP +
// device. Deduped within 30s per actor+record so a refresh isn't counted as a new view.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";

function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { entityType?: string; entityId?: string };
  const { entityType, entityId } = body;
  if (!entityType || !entityId) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  if (entityType !== "lead") return NextResponse.json({ ok: true }); // only lead views for now

  // Dedupe: same viewer + record within 30s counts as one look.
  const recent = await prisma.auditLog.findFirst({
    where: { action: "record.view", entityType, entityId, actorId: user.id, at: { gt: new Date(Date.now() - 30_000) } },
    select: { id: true },
  });
  if (recent) return NextResponse.json({ ok: true, deduped: true });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "record.view",
    entityType,
    entityId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
