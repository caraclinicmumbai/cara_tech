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
import { isWithinDnd } from "@/lib/callWindow";
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
///
/// `relaxed` also accepts Offline. Presence flips a counsellor to Offline after 15 minutes
/// without the CRM open (lib/presence.ts sweepIdle), which says nothing about whether
/// their phone is in their pocket — and a patient ringing the clinic must reach SOMEONE.
/// So during clinic hours, when nobody is marked Available, Offline people are rung too.
/// Break and In-Consultation stay excluded: those are deliberate "don't ring me".
function isReachable(
  rep: { name: string; active: boolean; availability: string; onCall: boolean; phone: string | null },
  relaxed = false,
): boolean {
  const statusOk = rep.availability === "available" || (relaxed && rep.availability === "offline");
  if (!(rep.active && statusOk && !rep.onCall)) return false;
  if (!dialablePhone(rep.phone)) {
    logger.warn(`Inbound routing: skipping ${rep.name} — phone "${rep.phone}" is not dialable`);
    return false;
  }
  return true;
}

/// Is it clinic hours — when an Offline counsellor may still be rung? The same window
/// outbound calling uses (10:00–22:00 IST by default, lib/callWindow.ts).
function clinicHours(): boolean {
  return !isWithinDnd();
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
  const relaxOk = clinicHours();

  const connect = (
    rep: { id: string; name: string; phone: string | null; speciality: string | null },
    extra: { sticky: boolean; firstTime: boolean; reason: string },
  ): InboundRoute => ({
    kind: "connect",
    lead,
    rep: { id: rep.id, name: rep.name, phone: dialablePhone(rep.phone)!, speciality: rep.speciality },
    ...extra,
  });

  /// The next telecaller in the rota who can take it — Available first, then (in clinic
  /// hours) Offline. Skips everyone in `tried`, and adds whoever it looks at to it.
  const nextTelecaller = async (tried: string[]) => {
    for (const relaxed of relaxOk ? [false, true] : [false]) {
      for (let i = 0; i < 20; i++) {
        const candidate = await pickNextTelecaller(tried, { includeOffline: relaxed });
        if (!candidate) break;
        tried.push(candidate.id);
        if (isReachable(candidate, relaxed)) return candidate;
      }
    }
    return null;
  };

  // ── First-time caller (no owner yet): telecallers, round-robin ──
  if (!lead.ownerRepId) {
    const rep = await nextTelecaller([...exclude]);
    return rep
      ? connect(rep, { sticky: false, firstTime: true, reason: `New caller - round-robin to ${rep.name}` })
      : { kind: "nobody", lead, reason: "No telecaller is available" };
  }

  const owner = await prisma.salesRep.findUnique({ where: { id: lead.ownerRepId }, select: REP_FIELDS });

  // ── 1. The owner — their patient is calling. Rung if Available, or Offline in clinic
  // hours; skipped on Break / In consultation / already on a call. A sales head who
  // personally owns a lead still gets their caller back: stickiness is about who this
  // patient knows, not about the rota.
  if (owner && !exclude.has(owner.id) && isReachable(owner, relaxOk)) {
    return connect(owner, { sticky: true, firstTime: false, reason: `${owner.name} owns this lead` });
  }

  // ── 2. An Available colleague — same speciality first, then the round-robin ──
  // pickReplacementFor() encodes "prefer the same skill, else anyone free" and advances
  // the round-robin cursor so cover work spreads evenly.
  const ownerSpeciality = owner?.speciality ?? null;
  const tried = new Set(exclude);
  tried.add(lead.ownerRepId);
  const covered = (rep: { name: string; speciality: string | null }) => {
    const sameSkill = !!ownerSpeciality && rep.speciality?.toLowerCase() === ownerSpeciality.toLowerCase();
    return `${lead.ownerRepName ?? "Owner"} unavailable - covered by ${rep.name}${sameSkill ? " (same speciality)" : ""}`;
  };
  for (let i = 0; i < 5; i++) {
    const candidate = await pickReplacementFor({ id: lead.ownerRepId, speciality: ownerSpeciality });
    if (!candidate) break;
    if (tried.has(candidate.id)) continue; // already rang this one on this call — the cursor moved on
    tried.add(candidate.id);
    if (!isReachable(candidate)) continue;
    return connect(candidate, { sticky: false, firstTime: false, reason: covered(candidate) });
  }

  // ── 3. Nobody Available: in clinic hours, any telecaller not on a break ──
  if (relaxOk) {
    const rep = await nextTelecaller([...tried]);
    if (rep) return connect(rep, { sticky: false, firstTime: false, reason: covered(rep) });
  }

  return {
    kind: "nobody",
    lead,
    reason: lead.ownerRepName
      ? `${lead.ownerRepName} and every colleague are unavailable`
      : "No counsellor is available",
  };
}
