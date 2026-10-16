// The calendar → HR (3.8) and Assets (3.9): how much each doctor, staff member, room and
// machine was used (§3, decision 3.a). Procedures per doctor feed commission and
// performance; a machine's uses (window and lifetime) feed its service interval.
//
//   GET ?from=ISO&to=ISO&kind=doctor|equipment|staff|room
//
// Shared machine secret (`x-webhook-secret`). Window defaults to the last 30 days, at most 366.
import { NextResponse } from "next/server";
import { verifyWebhookSecret } from "@/lib/verify";
import { utilisation } from "@/lib/scheduling/handoffs";

const DAY = 86_400_000;
const KINDS = ["doctor", "equipment", "staff", "room"] as const;

export async function GET(req: Request) {
  if (!verifyWebhookSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const to = parse(url.searchParams.get("to")) ?? new Date();
  const from = parse(url.searchParams.get("from")) ?? new Date(to.getTime() - 30 * DAY);
  if (!(to > from) || to.getTime() - from.getTime() > 366 * DAY) {
    return NextResponse.json({ error: "from must be before to, at most 366 days apart" }, { status: 400 });
  }
  const k = url.searchParams.get("kind");
  const kind = (KINDS as readonly string[]).includes(k ?? "") ? (k as (typeof KINDS)[number]) : undefined;
  return NextResponse.json({ from, to, resources: await utilisation({ from, to, kind }) });
}

function parse(v: string | null): Date | null {
  return v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null;
}
