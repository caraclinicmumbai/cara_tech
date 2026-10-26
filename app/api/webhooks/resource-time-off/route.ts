// HR (3.8) and Assets (3.9) → the calendar: a doctor's approved leave, or a machine's
// maintenance / calibration downtime (§3, decision 3.a). The feeding system posts the
// absence with its own id; the CRM blocks the calendar exactly as leave entered by hand
// does, and opens rebooking cases for anything already booked — nothing is moved or
// cancelled automatically (2.9.b).
//
// Authenticated with the shared machine secret (`x-webhook-secret`). Idempotent on
// `externalId`: re-posting moves or withdraws the same absence (`status: "cancelled"`).
// `resource` is our resource id or its external reference (employee code / asset tag,
// set on the resource in /appointments/setup).
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyWebhookSecret } from "@/lib/verify";
import { upsertExternalTimeOff } from "@/lib/scheduling/handoffs";

const schema = z.object({
  source: z.enum(["hr", "assets"]),
  externalId: z.string().min(1).max(200),
  resource: z.string().min(1).max(200),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  kind: z.enum(["leave", "conference", "training", "travel", "maintenance", "calibration", "other"]).optional(),
  reason: z.string().max(500).optional(),
  status: z.enum(["approved", "cancelled"]).default("approved"),
});

export async function POST(req: Request) {
  if (!verifyWebhookSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
  const r = await upsertExternalTimeOff({ ...parsed.data, startAt: new Date(parsed.data.startAt), endAt: new Date(parsed.data.endAt) });
  return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 422 });
}
