// Counsellor Performance (§reports 4) — leads handled, consultations booked, quotes
// raised, what converted.
//
// The measurement choice that matters here: a counsellor is credited for the leads
// ASSIGNED to them inside the range (`assignedAt`), not for leads created in it. Leads
// are assigned at intake, so for a normal week the two are the same set; they diverge
// when a lead is handed over, and a handover should move the credit with the work.
//
// Revenue columns are computed but the page only shows them to `reports.revenue` —
// see app/(dashboard)/reports/page.tsx.

import { prisma } from "@/lib/prisma";
import { within, type DateRange } from "@/lib/reports/range";
import {
  bookedConsultation,
  didConsultation,
  isWon,
  quoteValue,
  rate,
  median,
} from "@/lib/reports/shared";

export type CounsellorRow = {
  repId: string;
  repName: string;
  active: boolean;
  branchName: string | null;
  /// Leads assigned to them in the range.
  leads: number;
  /// Of those, how many reached a booked consultation, and how many completed one.
  consultationsBooked: number;
  consultationsDone: number;
  bookingRatePct: number | null;
  /// Leads they were handed and lost before ever consulting (§3.1 premature loss).
  prematureLost: number;
  /// Human-handover calls they placed in the range, and how long they took to pick a
  /// handover up (median) — the responsiveness half of the picture.
  callsPlaced: number;
  medianPickupMs: number | null;
  /// Quotes THEY own, raised in the range, and how many of those have converted since.
  quotesRaised: number;
  quotesConverted: number;
  quoteConversionPct: number | null;
  /// Money from quotes that converted IN the range (a different question from the line
  /// above, which follows a cohort of quotes forward).
  convertedInRange: number;
  revenue: number;
};

export type CounsellorReport = {
  rows: CounsellorRow[];
  totals: {
    leads: number;
    consultationsBooked: number;
    consultationsDone: number;
    quotesRaised: number;
    quotesConverted: number;
    convertedInRange: number;
    revenue: number;
  };
  /// Leads assigned in the range with no owner at all — they appear in no row.
  unassignedLeads: number;
  /// Quotes with no owning counsellor. These belong to nobody's row, so without them
  /// stated the table can show every counsellor at zero while the clinic sold plenty —
  /// a quote raised from an unlinked login, or before quote ownership was set, has no
  /// `ownerRepId`. Stated rather than silently dropped.
  unowned: { quotesRaised: number; convertedInRange: number; revenue: number };
};

export async function counsellorPerformance(range: DateRange): Promise<CounsellorReport> {
  const [reps, leads, quotesRaised, quotesConverted, calls, handovers] = await Promise.all([
    prisma.salesRep.findMany({
      select: {
        id: true,
        name: true,
        active: true,
        salesHead: true,
        branch: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.lead.findMany({
      where: { assignedAt: within(range), deletedAt: null },
      // Quote statuses come along so a patient who bought counts as consulted even when
      // nobody moved their stage — see bookedConsultation() in lib/reports/shared.ts.
      select: {
        assignedRepId: true,
        stage: true,
        prematureLost: true,
        quotes: { select: { status: true } },
      },
    }),
    prisma.quote.findMany({
      where: { createdAt: within(range) },
      select: { ownerRepId: true, status: true },
    }),
    prisma.quote.findMany({
      where: { convertedAt: within(range) },
      select: {
        ownerRepId: true,
        totalPayable: true,
        price: true,
        invoices: { select: { amount: true } },
      },
    }),
    prisma.call.groupBy({
      by: ["handledById"],
      where: { createdAt: within(range), handledById: { not: null } },
      _count: { _all: true },
    }),
    // Pickup speed per rep, over the same window (mirrors lib/reports/funnel.ts).
    prisma.lead.findMany({
      where: { handoverAt: within(range), deletedAt: null, assignedRepId: { not: null } },
      select: { id: true, assignedRepId: true, handoverAt: true },
    }),
  ]);

  // First human touch after each handover, for the median pickup column.
  const pickupByRep = new Map<string, number[]>();
  if (handovers.length > 0) {
    const ids = handovers.map((h) => h.id);
    const earliest = handovers.reduce(
      (min, h) => (h.handoverAt! < min ? h.handoverAt! : min),
      handovers[0].handoverAt!,
    );
    const [touchCalls, touchMessages] = await Promise.all([
      prisma.call.findMany({
        where: {
          leadId: { in: ids },
          createdAt: { gte: earliest },
          OR: [{ callType: "human_handover" }, { handledById: { not: null } }],
        },
        select: { leadId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.message.findMany({
        where: {
          leadId: { in: ids },
          createdAt: { gte: earliest },
          direction: "outbound",
          automated: false,
        },
        select: { leadId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const touches = new Map<string, Date>();
    for (const t of [...touchCalls, ...touchMessages]) {
      const cur = touches.get(t.leadId);
      if (!cur || t.createdAt < cur) touches.set(t.leadId, t.createdAt);
    }
    for (const h of handovers) {
      const touch = touches.get(h.id);
      if (!touch || touch <= h.handoverAt!) continue;
      const list = pickupByRep.get(h.assignedRepId!) ?? [];
      list.push(touch.getTime() - h.handoverAt!.getTime());
      pickupByRep.set(h.assignedRepId!, list);
    }
  }

  const callCount = new Map(
    calls.map((c) => [c.handledById as string, c._count._all]),
  );

  const rows: CounsellorRow[] = reps.map((rep) => {
    const mine = leads.filter((l) => l.assignedRepId === rep.id);
    const bought = (l: (typeof leads)[number]) => l.quotes.some((q) => isWon(q.status));
    const booked = mine.filter((l) => bookedConsultation(l.stage, bought(l))).length;
    const done = mine.filter((l) => didConsultation(l.stage, bought(l))).length;
    const raised = quotesRaised.filter((q) => q.ownerRepId === rep.id);
    const raisedWon = raised.filter((q) => isWon(q.status)).length;
    const converted = quotesConverted.filter((q) => q.ownerRepId === rep.id);

    return {
      repId: rep.id,
      repName: rep.salesHead ? `${rep.name} (head)` : rep.name,
      active: rep.active,
      branchName: rep.branch?.name ?? null,
      leads: mine.length,
      consultationsBooked: booked,
      consultationsDone: done,
      bookingRatePct: rate(booked, mine.length),
      prematureLost: mine.filter((l) => l.prematureLost).length,
      callsPlaced: callCount.get(rep.id) ?? 0,
      medianPickupMs: median(pickupByRep.get(rep.id) ?? []),
      quotesRaised: raised.length,
      quotesConverted: raisedWon,
      quoteConversionPct: rate(raisedWon, raised.length),
      convertedInRange: converted.length,
      revenue: converted.reduce((sum, q) => sum + (quoteValue(q) ?? 0), 0),
    };
  });

  // A rep with nothing at all in the window is noise on the table; keep anyone who did
  // something, plus every active rep (a zero row for an active counsellor IS a finding).
  const visible = rows.filter(
    (r) =>
      r.active ||
      r.leads > 0 ||
      r.quotesRaised > 0 ||
      r.convertedInRange > 0 ||
      r.callsPlaced > 0,
  );

  const sum = (pick: (r: CounsellorRow) => number) => visible.reduce((a, r) => a + pick(r), 0);

  return {
    rows: visible.sort(
      (a, b) => b.convertedInRange - a.convertedInRange || b.leads - a.leads || a.repName.localeCompare(b.repName),
    ),
    totals: {
      leads: sum((r) => r.leads),
      consultationsBooked: sum((r) => r.consultationsBooked),
      consultationsDone: sum((r) => r.consultationsDone),
      quotesRaised: sum((r) => r.quotesRaised),
      quotesConverted: sum((r) => r.quotesConverted),
      convertedInRange: sum((r) => r.convertedInRange),
      revenue: sum((r) => r.revenue),
    },
    unassignedLeads: leads.filter((l) => !l.assignedRepId).length,
    unowned: {
      quotesRaised: quotesRaised.filter((q) => !q.ownerRepId).length,
      convertedInRange: quotesConverted.filter((q) => !q.ownerRepId).length,
      revenue: quotesConverted
        .filter((q) => !q.ownerRepId)
        .reduce((sum, q) => sum + (quoteValue(q) ?? 0), 0),
    },
  };
}
