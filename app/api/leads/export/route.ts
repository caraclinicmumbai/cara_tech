// Audited CSV export of the leads list (§compliance). Gated to leads.export
// (managers/admin). Respects the caller's lead scope, applies optional filters, streams
// a CSV attachment, and records a lead.export audit row (who, when, row count, filters).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiCapability } from "@/lib/apiAuth";
import { currentUser, leadWhereForUser } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const { denied } = await requireApiCapability("leads.export");
  if (denied) return denied;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const stage = url.searchParams.get("stage")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() || undefined;

  const where: Prisma.LeadWhereInput = { deletedAt: null, ...leadWhereForUser(user) };
  if (stage) where.stage = stage;
  if (status) where.status = status;
  if (q) where.OR = [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }];

  const leads = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: {
      id: true, name: true, phone: true, email: true, interest: true, stage: true, status: true,
      tag: true, source: true, campaign: true, createdAt: true,
      assignedRep: { select: { name: true } },
    },
  });

  const header = ["id", "name", "phone", "email", "interest", "stage", "status", "tag", "source", "campaign", "owner", "createdAt"];
  const rows = leads.map((l) => [
    l.id, l.name, l.phone, l.email, l.interest, l.stage, l.status, l.tag, l.source, l.campaign,
    l.assignedRep?.name ?? "", l.createdAt.toISOString(),
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

  const filters = { q: q ?? null, stage: stage ?? null, status: status ?? null };
  await writeAudit({
    actorId: user.id, actorEmail: user.email,
    action: "lead.export", entityType: "export", entityId: null,
    newValue: `${leads.length} leads`, meta: { count: leads.length, filters },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cara-leads-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
