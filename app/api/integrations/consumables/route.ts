// The calendar → Inventory (3.5): consumables to set aside for confirmed appointments
// (§3, decision 3.a). Inventory pulls what's requested and answers from its own stock; the
// CRM counts no stock.
//
//   GET ?status=requested|released|consumed&since=ISO   (default: requested, max 500)
//
// Shared machine secret (`x-webhook-secret`). Rows carry the appointment, its time and
// branch — never the patient.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyWebhookSecret } from "@/lib/verify";

export async function GET(req: Request) {
  if (!verifyWebhookSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = ["requested", "released", "consumed"].includes(url.searchParams.get("status") ?? "")
    ? url.searchParams.get("status")!
    : "requested";
  const since = url.searchParams.get("since");
  const rows = await prisma.consumableReservation.findMany({
    where: { status, ...(since && !Number.isNaN(Date.parse(since)) ? { updatedAt: { gte: new Date(since) } } : {}) },
    orderBy: { updatedAt: "asc" },
    take: 500,
    select: {
      id: true,
      sku: true,
      name: true,
      quantity: true,
      status: true,
      updatedAt: true,
      appointment: { select: { id: true, startAt: true, branchId: true, branch: { select: { name: true } }, type: { select: { name: true } } } },
    },
  });
  return NextResponse.json({
    reservations: rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      quantity: r.quantity,
      status: r.status,
      updatedAt: r.updatedAt,
      appointmentId: r.appointment.id,
      startAt: r.appointment.startAt,
      branchId: r.appointment.branchId,
      branchName: r.appointment.branch.name,
      appointmentType: r.appointment.type.name,
    })),
  });
}
