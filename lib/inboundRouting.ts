// Inbound call routing (§presence, §3.1) — who should pick up when a patient rings
// the published clinic number.
//
// The rule, in order:
//   1. STICKY — the rep who owns this caller's lead. A patient who calls back reaches
//      the person they already spoke to, for as long as that person owns the lead.
//   2. Only if the owner can't take it (offline, on a break, mid-consultation, already
//      on a call, or simply didn't answer) do we look elsewhere — preferring a
//      colleague with the SAME speciality, then the round-robin.
//   3. Nobody free → the caller is held briefly, then offered voicemail, and the
//      owner gets a "return this call" step on the lead's roadmap.
//
// A FIRST-TIME caller has nobody to be sticky to. They ring the telecallers round-robin,
// and the lead is NOT assigned until one of them answers — whoever picks up owns the lead
// from then on, so the next call is sticky to them (claimUnownedLead, called from the
// whisper routes on answer). Assigning a rota pick before anyone rang used to give the
// lead to a telecaller who might never have spoken to the patient.
//
// Deliberately provider-agnostic: this module decides WHO, and knows nothing about
// TwiML, webhooks or signatures. The Twilio adapter lives in app/api/twilio/inbound.
// Swapping to another carrier means writing a new adapter against `routeInboundCall`,
// not rewriting the policy.
import { prisma } from "@/lib/prisma";
import { ingestLead } from "@/lib/leadIntake";
import { pickNextTelecaller, pickReplacementFor } from "@/lib/salesReps";
import { dialablePhone } from "@/lib/phone";
import { logger } from "@/lib/logger";

/// A rep who can actually take a call right now.
export type RoutableRep = {
  id: string;
  name: string;
  phone: string;
  speciality: string | null;
};

export type InboundLead = {
  id: string;
  name: string;
  phone: string;
  /// True when this call created the record (nobody in the CRM knew this number).
  isNew: boolean;
  /// The rep who owns the lead — the sticky target, whether or not they're free.
  ownerRepId: string | null;
  ownerRepName: string | null;
};

export type InboundRoute =
  | {
      kind: "connect";
      lead: InboundLead;
      rep: RoutableRep;
      /// True when we reached the lead's own owner (the sticky target).
      sticky: boolean;
      /// The lead has no owner yet: whoever answers this leg becomes its owner.
      firstTime: boolean;
      /// Why this rep, in words — logged and shown on the lead.
      reason: string;
    }
  | {
      kind: "nobody";
      lead: InboundLead;
      reason: string;
    };

/// Last 10 digits — the same match the dedup path uses, so "+919876543210",
/// "9876543210" and "09876543210" are one person.
function last10(phone: string): string {
  return (phone.match(/\d/g)?.join("") ?? "").slice(-10);
}

// A rep's number in a form a carrier can actually dial lives in lib/phone.ts now —
// the click-to-call path needs the same normalisation. Re-exported so existing
// importers of this module keep working unchanged.
export { dialablePhone };

/// A rep is reachable when they're employed, on the floor, not already talking, and
/// carry a number we can actually dial.
function isReachable(rep: {
  name: string;
  active: boolean;
  availability: string;
  onCall: boolean;
  phone: string | null;
}): boolean {
  if (!(rep.active && rep.availability === "available" && !rep.onCall)) return false;
  if (!dialablePhone(rep.phone)) {
    logger.warn(`Inbound routing: skipping ${rep.name} — phone "${rep.phone}" is not dialable`);
    return false;
  }
  return true;
}

const REP_FIELDS = {
  id: true,
  name: true,
  phone: true,
  speciality: true,
  active: true,
  availability: true,
  onCall: true,
  salesHead: true,
} as const;

/// The caller's lead. Matches on the last 10 digits and takes the EARLIEST record —
/// the same anchor the duplicate detector uses, so a person with duplicate records
/// resolves to one canonical history rather than to whichever copy is newest.
/// Creates the lead when the number is unknown to us.
async function leadForCaller(fromPhone: string): Promise<InboundLead> {
  const digits = last10(fromPhone);
  const existing =
    digits.length >= 7
      ? await prisma.lead.findFirst({
          where: { deletedAt: null, phone: { contains: digits } },
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true, phone: true, assignedRepId: true, assignedRep: { select: { name: true } } },
        })
      : null;

  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      phone: existing.phone,
      isNew: false,
      ownerRepId: existing.assignedRepId,
      ownerRepName: existing.assignedRep?.name ?? null,
    };
  }

  // Unknown caller: capture them now so the conversation has somewhere to live.
  // `inbound_call` never triggers an automated AI call. The lead is left UNOWNED — the
  // telecaller who answers this call claims it.
  const { lead } = await ingestLead({
    name: `Caller ${digits.slice(-4) || "unknown"}`,
    phone: fromPhone,
    source: "inbound_call",
    deferOwner: true,
  });
  logger.info(`Inbound call from unknown number ${fromPhone} → created lead ${lead.id}`);
  return {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    isNew: true,
    ownerRepId: null,
    ownerRepName: null,
  };
}

/// Decide who takes this call.
///
/// `exclude` carries the reps already tried on THIS call — a rep whose phone rang out
/// or was busy. That's what lets one call walk down the ladder (owner → same
/// speciality → round-robin) instead of ringing the same silent handset forever.
export async function routeInboundCall(
  fromPhone: string,
  opts: { exclude?: string[] } = {},
): Promise<InboundRoute> {
  const exclude = new Set(opts.exclude ?? []);
  const lead = await leadForCaller(fromPhone);

  // ── First-time caller (no owner yet): telecallers, round-robin ──
  if (!lead.ownerRepId) {
    const tried = [...exclude];
    for (let i = 0; i < 10; i++) {
      const candidate = await pickNextTelecaller(tried);
      if (!candidate) break;
      tried.push(candidate.id);
      if (!isReachable(candidate)) continue;
      return {
        kind: "connect",
        lead,
        rep: {
          id: candidate.id,
          name: candidate.name,
          phone: dialablePhone(candidate.phone)!,
          speciality: candidate.speciality,
        },
        sticky: false,
        firstTime: true,
        reason: `New caller - round-robin to ${candidate.name}`,
      };
    }
    return { kind: "nobody", lead, reason: "No telecaller is available" };
  }

  // ── 1. The owner, if they can take it ──
  if (lead.ownerRepId && !exclude.has(lead.ownerRepId)) {
    const owner = await prisma.salesRep.findUnique({
      where: { id: lead.ownerRepId },
      select: REP_FIELDS,
    });
    // A sales head who personally owns a lead still gets their caller back: the
    // round-robin excludes managers, but stickiness is about who this patient knows.
    if (owner && isReachable(owner)) {
      return {
        kind: "connect",
        lead,
        rep: {
          id: owner.id,
          name: owner.name,
          phone: dialablePhone(owner.phone)!,
          speciality: owner.speciality,
        },
        sticky: true,
        firstTime: false,
        reason: `${owner.name} owns this lead`,
      };
    }
  }

  // ── 2. A colleague — same speciality first, then the round-robin ──
  // pickReplacementFor() already encodes "prefer the same skill, else anyone free",
  // and advances the round-robin cursor so cover work spreads evenly.
  let ownerSpeciality: string | null = null;
  if (lead.ownerRepId) {
    const owner = await prisma.salesRep.findUnique({
      where: { id: lead.ownerRepId },
      select: { speciality: true },
    });
    ownerSpeciality = owner?.speciality ?? null;
  }

  // Walk the ladder, skipping anyone already tried on this call.
  const tried = new Set(exclude);
  if (lead.ownerRepId) tried.add(lead.ownerRepId);
  for (let i = 0; i < 5; i++) {
    const candidate = await pickReplacementFor({ id: lead.ownerRepId, speciality: ownerSpeciality });
    if (!candidate) break;
    if (tried.has(candidate.id)) {
      tried.add(candidate.id);
      continue; // already rang this one on this call — advance the cursor and retry
    }
    if (!isReachable(candidate)) {
      tried.add(candidate.id);
      continue;
    }
    // Who the caller belongs to — the reason line names them, not the cover.
    const previousOwner = lead.ownerRepName;
    const sameSkill =
      !!ownerSpeciality && candidate.speciality?.toLowerCase() === ownerSpeciality.toLowerCase();
    return {
      kind: "connect",
      lead,
      rep: {
        id: candidate.id,
        name: candidate.name,
        phone: dialablePhone(candidate.phone)!,
        speciality: candidate.speciality,
      },
      sticky: false,
      firstTime: false,
      reason: previousOwner
        ? `${previousOwner} unavailable - covered by ${candidate.name}${sameSkill ? " (same speciality)" : ""}`
        : `Round-robin to ${candidate.name}`,
    };
  }

  return {
    kind: "nobody",
    lead,
    reason: lead.ownerRepName
      ? `${lead.ownerRepName} and every colleague are unavailable`
      : "No counsellor is available",
  };
}
