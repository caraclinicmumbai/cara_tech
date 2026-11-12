// Audited CSV export of the leads list (§compliance). Gated to leads.export
// (managers/admin). Respects the caller's lead scope, applies optional filters, streams
// a CSV attachment, and records a lead.export audit row (who, when, row count, filters).
//
// After the lead's own fields come the working columns the clinic's previous CRM exported
// (follow-up, last call, closure, quote, remarks), named as that sheet named them so the
// team's existing spreadsheets keep working. Dates and times are IST.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApiCapability } from "@/lib/apiAuth";
import { currentUser, leadWhereForUser } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import { isConnectedCall } from "@/lib/callList";
import { callOutcomeLabel } from "@/lib/clickToCallLog";
import { istDateTimeLocal } from "@/lib/datetime";
import type { Prisma } from "@prisma/client";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/// "YYYY-MM-DD HH:mm" in IST.
const istStamp = (d: Date) => istDateTimeLocal(d).replace("T", " ");
const yesNo = (b: boolean) => (b ? "yes" : "no");

/// Quotes that don't count as quoted: one superseded by a newer version, and one the
/// clinic withdrew. Counting a replaced quote would add its amount twice.
const NOT_QUOTED = ["replaced", "withdrawn"];
/// The summary comment the previous-CRM import wrote on each lead. It restates the old
/// CRM's fields, not a remark anyone made, so it isn't counted as one.
const IMPORT_SUMMARY_AUTHOR = "Legacy import";

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
    // Room for the whole book (the old-CRM import alone is ~7,100 leads); a cut-off list
    // would pass for a complete one.
    take: 20000,
    select: {
      id: true, name: true, phone: true, alternatePhone: true, email: true, interest: true, stage: true,
      status: true, tag: true, source: true, campaign: true, createdAt: true, lostTag: true, lostReason: true,
      externalId: true,
      assignedRep: { select: { name: true } },
    },
  });

  const ids = leads.map((l) => l.id);
  const [followUps, calls, quotes, comments, lostMoves] = await Promise.all([
    // Soonest pending follow-up per lead — the same "next follow-up" the leads table shows.
    prisma.leadFollowUpStep.findMany({
      where: { leadId: { in: ids }, status: "pending", dueAt: { not: null } },
      distinct: ["leadId"],
      orderBy: [{ leadId: "asc" }, { dueAt: "asc" }],
      select: { leadId: true, dueAt: true },
    }),
    prisma.call.findMany({
      where: { leadId: { in: ids } },
      orderBy: { createdAt: "desc" },
      select: { leadId: true, createdAt: true, outcome: true, duration: true, callType: true },
    }),
    prisma.quote.findMany({
      where: { leadId: { in: ids }, status: { notIn: NOT_QUOTED } },
      orderBy: { createdAt: "asc" },
      select: { leadId: true, treatment: true, price: true, quantity: true, totalPayable: true },
    }),
    prisma.leadComment.findMany({
      where: { leadId: { in: ids }, NOT: { authorName: IMPORT_SUMMARY_AUTHOR } },
      orderBy: { createdAt: "desc" },
      select: { leadId: true, body: true, authorName: true, createdAt: true },
    }),
    // Who last moved each lead to Lost. Automations (a campaign finishing, win-back) move
    // leads too, and leave no person on the row.
    prisma.auditLog.findMany({
      where: { action: "lead.stage.move", newValue: "lost", entityType: "lead", entityId: { in: ids } },
      distinct: ["entityId"],
      orderBy: [{ entityId: "asc" }, { at: "desc" }],
      select: { entityId: true, actorId: true },
    }),
  ]);

  const group = <T extends { leadId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.leadId);
      if (list) list.push(r);
      else m.set(r.leadId, [r]);
    }
    return m;
  };
  const nextFollowUp = new Map(followUps.map((f) => [f.leadId, f.dueAt!]));
  const callsBy = group(calls);
  const quotesBy = group(quotes);
  const commentsBy = group(comments);
  const lostMoved = new Set(lostMoves.map((a) => a.entityId!));
  const closedByPerson = new Set(lostMoves.filter((a) => a.actorId).map((a) => a.entityId!));
  const maxRemarks = Math.max(0, ...[...commentsBy.values()].map((c) => c.length));

  const header = [
    "id", "name", "phone", "email", "interest", "stage", "status", "tag", "source", "campaign", "owner", "createdAt",
    "next_followup_date", "last_call_date", "last_call_time", "last_call_status", "call_not_connected_reason",
    "call_attempt_count", "lead_closed_by_executive", "lead_closed_reason", "alternate_number",
    "quote_generated", "quote_treatment_recommended", "quote_amount_total", "total_comments",
    ...Array.from({ length: maxRemarks }, (_, i) => {
      const n = i + 1;
      return [n === 1 ? "Remark 1 (latest)" : `Remark ${n}`, `Remark ${n} Added By`, `Remark ${n} Timestamp`];
    }).flat(),
  ];

  const rows = leads.map((l) => {
    const leadCalls = callsBy.get(l.id) ?? [];
    const last = leadCalls[0];
    const connected = last ? isConnectedCall(last) : false;
    // Attempts are the calls the clinic made; a patient ringing in isn't one.
    const attempts = leadCalls.filter((c) => !c.callType.startsWith("inbound")).length;
    const lost = l.stage === "lost";
    const leadQuotes = quotesBy.get(l.id) ?? [];
    const treatments = [...new Set(leadQuotes.map((qt) => qt.treatment.trim()).filter(Boolean))];
    // A quote saved without a price has no amount; it adds nothing rather than a 0.
    const priced = leadQuotes.filter((qt) => qt.totalPayable != null || qt.price != null);
    const quoteTotal = priced.reduce((sum, qt) => sum + (qt.totalPayable ?? qt.price! * qt.quantity), 0);
    const remarks = commentsBy.get(l.id) ?? [];
    const due = nextFollowUp.get(l.id);
    const lastAt = last ? istDateTimeLocal(last.createdAt).split("T") : null;

    return [
      l.id, l.name, l.phone, l.email, l.interest, l.stage, l.status, l.tag, l.source, l.campaign,
      l.assignedRep?.name ?? "", l.createdAt.toISOString(),
      due ? istStamp(due) : "",
      lastAt?.[0] ?? "",
      lastAt?.[1] ?? "",
      last ? (connected ? "Connected" : "Not Connected") : "",
      last && !connected ? callOutcomeLabel(last.outcome, last.createdAt) : "",
      attempts,
      // A lead that arrived lost from the previous CRM has no record here of who closed it.
      lost && !closedByPerson.has(l.id) && l.externalId?.startsWith("legacy:") && !lostMoved.has(l.id)
        ? ""
        : yesNo(lost && closedByPerson.has(l.id)),
      lost ? [l.lostTag, l.lostReason].filter(Boolean).join(" — ") : "",
      l.alternatePhone,
      yesNo(leadQuotes.length > 0),
      treatments.join("; "),
      priced.length ? quoteTotal : "",
      remarks.length,
      ...remarks.flatMap((c) => [c.body, c.authorName ?? "", istStamp(c.createdAt)]),
    ];
  });
  // Every row as wide as the header, however few remarks it has.
  for (const r of rows) while (r.length < header.length) r.push("");
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
