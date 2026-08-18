// Read models for the post-sales ERP screens (§post-sales). Kept apart from the
// mutation logic in journeys.ts so the pages have one obvious place to fetch from, and
// so the shapes the client components receive are plain serialisable objects (dates as
// ISO strings) — RSC → client props.
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  JOURNEY_STAGES,
  TERMINAL_JOURNEY_STAGE,
  isCheckInOpen,
  type JourneyStage,
} from "@/lib/postSales/stages";

export type JourneyCard = {
  id: string;
  quoteId: string;
  leadId: string;
  patientName: string;
  procedure: string;
  cycle: number;
  stage: string;
  stageChangedAt: string; // ISO
  stageDueAt: string | null; // ISO
  daysInStage: number;
  /// Days past the stage limit; 0 when on time or unlimited.
  daysOverdue: number;
  overdue: boolean;
  treatmentType: string;
  branchName: string | null;
  doctorId: string | null;
  doctorName: string | null;
  otLeadId: string | null;
  otLeadName: string | null;
  consultantId: string | null;
  consultantName: string | null;
  surgeryAt: string | null; // ISO
  totalPayable: number | null;
  /// Check-ins still to happen on this journey (pending or failed).
  openCheckIns: number;
  /// Check-ins that need a human (blocked) — the most actionable number on the card.
  blockedCheckIns: number;
  /// The patient's OTHER live journeys — so nobody treats this as their only treatment.
  siblingJourneys: number;
  /// Any hard safety flag on the patient, surfaced on the card itself.
  flagged: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const CARD_SELECT = {
  id: true,
  quoteId: true,
  leadId: true,
  stage: true,
  stageChangedAt: true,
  stageDueAt: true,
  treatmentType: true,
  surgeryAt: true,
  doctorId: true,
  otLeadId: true,
  consultantId: true,
  quote: { select: { treatment: true, cycle: true, totalPayable: true } },
  lead: {
    select: {
      name: true,
      possibleMinor: true,
      legalThreatFreeze: true,
      complaintOpen: true,
      consentClinical: true,
    },
  },
  branch: { select: { name: true } },
  doctor: { select: { name: true, email: true } },
  otLead: { select: { name: true, email: true } },
  consultant: { select: { name: true, email: true } },
  checkIns: { select: { status: true } },
} satisfies Prisma.PostSalesJourneySelect;

type CardRow = Prisma.PostSalesJourneyGetPayload<{ select: typeof CARD_SELECT }>;

function staffName(u: { name: string | null; email: string } | null): string | null {
  if (!u) return null;
  return u.name?.trim() || u.email;
}

function toCard(j: CardRow, siblingCount: number, now: number): JourneyCard {
  const checkIns = j.checkIns ?? [];
  const daysOverdue = j.stageDueAt ? Math.max(0, Math.floor((now - j.stageDueAt.getTime()) / DAY_MS)) : 0;
  return {
    id: j.id,
    quoteId: j.quoteId,
    leadId: j.leadId,
    patientName: j.lead.name,
    procedure: j.quote.treatment,
    cycle: j.quote.cycle,
    stage: j.stage,
    stageChangedAt: j.stageChangedAt.toISOString(),
    stageDueAt: j.stageDueAt?.toISOString() ?? null,
    daysInStage: Math.max(0, Math.floor((now - j.stageChangedAt.getTime()) / DAY_MS)),
    daysOverdue,
    overdue: !!j.stageDueAt && j.stageDueAt.getTime() < now && j.stage !== TERMINAL_JOURNEY_STAGE,
    treatmentType: j.treatmentType,
    branchName: j.branch?.name ?? null,
    doctorId: j.doctorId,
    doctorName: staffName(j.doctor),
    otLeadId: j.otLeadId,
    otLeadName: staffName(j.otLead),
    consultantId: j.consultantId,
    consultantName: staffName(j.consultant),
    surgeryAt: j.surgeryAt?.toISOString() ?? null,
    totalPayable: j.quote.totalPayable,
    openCheckIns: checkIns.filter((c) => isCheckInOpen(c.status)).length,
    blockedCheckIns: checkIns.filter((c) => c.status === "blocked").length,
    siblingJourneys: siblingCount,
    flagged:
      j.lead.possibleMinor ||
      j.lead.legalThreatFreeze ||
      j.lead.complaintOpen ||
      j.lead.consentClinical === false,
  };
}

export type BoardFilter = {
  /// Restrict to journeys where this user holds one of the three clinical roles.
  mineUserId?: string | null;
  branchId?: string | null;
  /// Include journeys that have reached Closed Successfully (off by default).
  includeClosed?: boolean;
  onlyOverdue?: boolean;
};

export type Board = {
  columns: { stage: JourneyStage; cards: JourneyCard[] }[];
  total: number;
  overdue: number;
  blockedCheckIns: number;
  /// Patients (not journeys) with more than one live journey — the coordination risk.
  patientsWithMultiple: number;
};

/// The board: every live journey grouped by stage, newest stall first inside a column.
export async function getBoard(filter: BoardFilter = {}): Promise<Board> {
  const where: Prisma.PostSalesJourneyWhereInput = {
    lead: { deletedAt: null },
  };
  if (!filter.includeClosed) where.stage = { not: TERMINAL_JOURNEY_STAGE };
  if (filter.branchId) where.branchId = filter.branchId;
  if (filter.mineUserId) {
    where.OR = [
      { consultantId: filter.mineUserId },
      { doctorId: filter.mineUserId },
      { otLeadId: filter.mineUserId },
    ];
  }
  if (filter.onlyOverdue) {
    where.stageDueAt = { lt: new Date() };
    where.stage = { not: TERMINAL_JOURNEY_STAGE };
  }

  const rows = await prisma.postSalesJourney.findMany({
    where,
    orderBy: [{ stageDueAt: "asc" }, { stageChangedAt: "asc" }],
    select: CARD_SELECT,
  });

  // Sibling count per patient: how many OTHER live journeys each patient has. One
  // grouped query rather than per-card — this is the number that tells a consultant
  // "coordinate before you message".
  const liveByLead = await prisma.postSalesJourney.groupBy({
    by: ["leadId"],
    where: { stage: { not: TERMINAL_JOURNEY_STAGE }, lead: { deletedAt: null } },
    _count: { _all: true },
  });
  const liveCount = new Map(liveByLead.map((g) => [g.leadId, g._count._all]));

  const now = Date.now();
  const cards = rows.map((r) => toCard(r, Math.max(0, (liveCount.get(r.leadId) ?? 1) - 1), now));

  return {
    columns: JOURNEY_STAGES.map((stage) => ({
      stage,
      cards: cards.filter((c) => c.stage === stage),
    })),
    total: cards.length,
    overdue: cards.filter((c) => c.overdue).length,
    blockedCheckIns: cards.reduce((n, c) => n + c.blockedCheckIns, 0),
    patientsWithMultiple: liveByLead.filter((g) => g._count._all > 1).length,
  };
}

export type CheckInView = {
  id: string;
  dayOffset: number;
  scheduledFor: string; // ISO
  originalFor: string; // ISO
  moved: boolean;
  status: string;
  sentAt: string | null;
  blockedReason: string | null;
  deferredReason: string | null;
  lastError: string | null;
  attempts: number;
  note: string | null;
};

export type NoteView = {
  id: string;
  kind: string;
  body: string;
  authorName: string;
  createdAt: string; // ISO
};

export type JourneyDetail = {
  card: JourneyCard;
  checkIns: CheckInView[];
  notes: NoteView[];
  /// The patient's other journeys, so post-sales can see the whole relationship.
  siblings: { id: string; procedure: string; stage: string; surgeryAt: string | null }[];
  /// Snapshot generation time, when a snapshot exists.
  handoverGeneratedAt: string | null;
  quoteStatus: string;
  /// True when an Admin has unlocked the converted quote — the commercial record is
  /// being edited, so the clinical team should expect the summary to change.
  quoteUnlocked: boolean;
};

/// Everything the journey page needs, apart from the live handover summary (which
/// buildHandoverSummary() computes separately so the volatile parts stay current).
export async function getJourneyDetail(journeyId: string): Promise<JourneyDetail | null> {
  const j = await prisma.postSalesJourney.findUnique({
    where: { id: journeyId },
    select: {
      ...CARD_SELECT,
      handoverGeneratedAt: true,
      quote: { select: { treatment: true, cycle: true, totalPayable: true, status: true, lockedAt: true } },
      checkIns: {
        orderBy: { dayOffset: "asc" },
        select: {
          id: true,
          dayOffset: true,
          scheduledFor: true,
          originalFor: true,
          status: true,
          sentAt: true,
          blockedReason: true,
          deferredReason: true,
          lastError: true,
          attempts: true,
          note: true,
        },
      },
      notes: {
        orderBy: { createdAt: "desc" },
        select: { id: true, kind: true, body: true, authorName: true, createdAt: true },
      },
    },
  });
  if (!j) return null;

  const siblingRows = await prisma.postSalesJourney.findMany({
    where: { leadId: j.leadId, id: { not: j.id } },
    orderBy: { openedAt: "desc" },
    select: { id: true, stage: true, surgeryAt: true, quote: { select: { treatment: true } } },
  });

  const now = Date.now();
  // toCard wants the checkIns-as-statuses shape; the detail query selected full rows.
  const cardRow = {
    ...j,
    checkIns: j.checkIns.map((c) => ({ status: c.status })),
  } as unknown as CardRow;
  const liveSiblings = siblingRows.filter((s) => s.stage !== TERMINAL_JOURNEY_STAGE).length;

  return {
    card: toCard(cardRow, liveSiblings, now),
    checkIns: j.checkIns.map((c) => ({
      id: c.id,
      dayOffset: c.dayOffset,
      scheduledFor: c.scheduledFor.toISOString(),
      originalFor: c.originalFor.toISOString(),
      moved: c.scheduledFor.getTime() !== c.originalFor.getTime(),
      status: c.status,
      sentAt: c.sentAt?.toISOString() ?? null,
      blockedReason: c.blockedReason,
      deferredReason: c.deferredReason,
      lastError: c.lastError,
      attempts: c.attempts,
      note: c.note,
    })),
    notes: j.notes.map((n) => ({
      id: n.id,
      kind: n.kind,
      body: n.body,
      authorName: n.authorName ?? "Staff",
      createdAt: n.createdAt.toISOString(),
    })),
    siblings: siblingRows.map((s) => ({
      id: s.id,
      procedure: s.quote.treatment,
      stage: s.stage,
      surgeryAt: s.surgeryAt?.toISOString() ?? null,
    })),
    handoverGeneratedAt: j.handoverGeneratedAt?.toISOString() ?? null,
    quoteStatus: j.quote.status,
    quoteUnlocked: !j.quote.lockedAt,
  };
}

/// Staff eligible for each post-sales assignment slot. Doctors and OT come from their
/// roles; the consultant slot also accepts front-desk and managers, because a small
/// clinic won't have a dedicated post-sales consultant on day one.
export async function getAssignableStaff(): Promise<{
  doctors: { id: string; name: string }[];
  otTeam: { id: string; name: string }[];
  consultants: { id: string; name: string }[];
}> {
  const users = await prisma.user.findMany({
    where: { role: { in: ["doctor", "ot_team", "post_sales_consultant", "front_desk", "branch_manager", "crm_admin"] } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, role: true },
  });
  const label = (u: (typeof users)[number]) => ({ id: u.id, name: u.name?.trim() || u.email });
  return {
    doctors: users.filter((u) => u.role === "doctor" || u.role === "crm_admin").map(label),
    otTeam: users.filter((u) => u.role === "ot_team" || u.role === "crm_admin").map(label),
    consultants: users
      .filter((u) => ["post_sales_consultant", "front_desk", "branch_manager", "crm_admin"].includes(u.role))
      .map(label),
  };
}
