// CRM → Billing: completed sessions (§3, 3.4 "completed sessions trigger revenue
// recognition"). Billing (or the clinic's accounting export) pulls what it hasn't taken
// yet and marks it taken; the CRM never books revenue itself.
//
//   GET  ?since=ISO&includeExported=1   → rows, oldest first (max 500)
//   POST { ids: [...] }                 → marks those rows exported
//
// Authenticated with the shared machine secret (`x-webhook-secret`), like every other
// system-to-system route.
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyWebhookSecret } from "@/lib/verify";

export async function GET(req: Request) {
  if (!verifyWebhookSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const sinceDate = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : null;
  const rows = await prisma.revenueEvent.findMany({
    where: {
      ...(url.searchParams.get("includeExported") === "1" ? {} : { exportedAt: null }),
      ...(sinceDate ? { occurredAt: { gte: sinceDate } } : {}),
    },
    orderBy: { occurredAt: "asc" },
    take: 500,
  });
  return NextResponse.json({ events: rows });
}

const markSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = markSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { ids: string[] }" }, { status: 400 });
  const r = await prisma.revenueEvent.updateMany({
    where: { id: { in: parsed.data.ids }, exportedAt: null },
    data: { exportedAt: new Date() },
  });
  return NextResponse.json({ ok: true, marked: r.count });
}
