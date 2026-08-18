// Per-treatment post-sales timings (§post-sales: "Time limits per stage, per
// treatment type. Hair transplant recovery is not PRP recovery. Overdue = alert.").
//
// Two jobs live here:
//   1. Resolve a quote's free-text treatment ("Hair Transplant (FUE) — 2500 grafts")
//      to a stable POLICY KEY ("hair_transplant"). The key is snapshotted onto the
//      journey at handover so a later rename can't silently re-time a journey that
//      is already in flight.
//   2. Answer "how long may this journey sit in this stage?" — from the admin-edited
//      TreatmentStagePolicy rows, falling back to the built-in defaults below so the
//      clock works on day one with no configuration at all.
import { prisma } from "@/lib/prisma";
import { JOURNEY_STAGES, DEFAULT_CHECKIN_DAYS, type JourneyStage } from "@/lib/postSales/stages";

/// Days allowed in each stage. A missing key = that stage has NO limit (it can never
/// go overdue) — which is how the terminal stage is expressed.
export type StageDays = Partial<Record<JourneyStage, number>>;

export type ResolvedPolicy = {
  treatmentType: string;
  label: string;
  stageDays: StageDays;
  checkInDays: number[];
  /// true when this came from the built-in defaults rather than a DB row — the
  /// policies screen shows it so an admin knows nothing has been configured yet.
  builtIn: boolean;
};

// ── Treatment → policy key ───────────────────────────────────────────
// Keyword matching against the quote's treatment text, most specific first. This is
// deliberately simple and readable: the clinic's catalog names are stable, and a
// wrong match falls back to "default" (safe timings) rather than breaking anything.

const TREATMENT_MATCHERS: { key: string; label: string; patterns: RegExp[] }[] = [
  {
    key: "hair_transplant",
    label: "Hair Transplant",
    patterns: [/hair\s*transplant/i, /\bfue\b/i, /\bfut\b/i, /\bdhi\b/i, /graft/i],
  },
  { key: "prp", label: "PRP / Injectable Course", patterns: [/\bprp\b/i, /platelet/i, /mesotherapy/i, /\bgfc\b/i] },
  {
    key: "skin_procedure",
    label: "Skin Procedure",
    patterns: [/laser/i, /peel/i, /hydrafacial/i, /\bskin\b/i, /pigment/i, /acne/i, /scar/i],
  },
  {
    key: "surgical_other",
    label: "Other Surgical Procedure",
    patterns: [/surgery/i, /surgical/i, /lipo/i, /implant/i, /graft/i, /rhinoplast/i],
  },
];

/// Built-in fallback timings, used until an admin edits the policies. Rationale:
///   • converted            — hand over to the clinical team promptly.
///   • pre_op               — tests/consents/slot; a transplant needs longer prep.
///   • surgery_done         — the day-of window; should move on almost immediately.
///   • post_op_followup     — the immediate-recovery arc (covers day 1 + day 7).
///   • recovery_monitoring  — the long arc (covers day 30 + day 90 and growth review).
/// The terminal stage is absent from every map on purpose: it never goes overdue.
const BUILT_IN: Record<string, { label: string; stageDays: StageDays; checkInDays: number[] }> = {
  hair_transplant: {
    label: "Hair Transplant",
    stageDays: { converted: 3, pre_op: 21, surgery_done: 2, post_op_followup: 14, recovery_monitoring: 120 },
    checkInDays: [1, 7, 30, 90],
  },
  prp: {
    label: "PRP / Injectable Course",
    stageDays: { converted: 3, pre_op: 7, surgery_done: 1, post_op_followup: 10, recovery_monitoring: 45 },
    checkInDays: [1, 7, 30],
  },
  skin_procedure: {
    label: "Skin Procedure",
    stageDays: { converted: 3, pre_op: 10, surgery_done: 1, post_op_followup: 10, recovery_monitoring: 60 },
    checkInDays: [1, 7, 30],
  },
  surgical_other: {
    label: "Other Surgical Procedure",
    stageDays: { converted: 3, pre_op: 21, surgery_done: 2, post_op_followup: 21, recovery_monitoring: 90 },
    checkInDays: [1, 7, 30, 90],
  },
  default: {
    label: "Default (any treatment)",
    stageDays: { converted: 3, pre_op: 14, surgery_done: 2, post_op_followup: 14, recovery_monitoring: 90 },
    checkInDays: [...DEFAULT_CHECKIN_DAYS],
  },
};

export const DEFAULT_POLICY_KEY = "default";

/// Every policy key the app knows about — the built-ins are always offered on the
/// policies screen so an admin can tune a treatment they haven't customised yet.
export const BUILT_IN_POLICY_KEYS = Object.keys(BUILT_IN);

/// Resolve a free-text treatment name to a stable policy key. Falls back to
/// "default" when nothing matches — never throws, never guesses wildly.
export function resolveTreatmentType(treatment: string | null | undefined): string {
  const t = (treatment ?? "").trim();
  if (!t) return DEFAULT_POLICY_KEY;
  for (const m of TREATMENT_MATCHERS) {
    if (m.patterns.some((p) => p.test(t))) return m.key;
  }
  return DEFAULT_POLICY_KEY;
}

/// Human label for a policy key (built-in name, or the key itself if custom).
export function policyLabel(key: string): string {
  return BUILT_IN[key]?.label ?? key;
}

/// Narrow an untrusted JSON value to a StageDays map: known stage keys only, and
/// only positive whole-day numbers. Anything else is dropped rather than trusted —
/// the column is JSON, so a hand-edited row could contain anything.
export function parseStageDays(value: unknown): StageDays {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: StageDays = {};
  for (const stage of JOURNEY_STAGES) {
    const raw = (value as Record<string, unknown>)[stage];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) out[stage] = n;
  }
  return out;
}

/// Narrow an untrusted check-in-day list: positive whole days, de-duplicated and
/// sorted ascending (the coordination rule relies on ascending urgency).
export function parseCheckInDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = value
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 3650);
  return [...new Set(days)].sort((a, b) => a - b);
}

/// The effective policy for a treatment type. Order of preference:
///   1. an active TreatmentStagePolicy row for this exact key
///   2. the active row flagged isDefault
///   3. the built-in map for this key
///   4. the built-in "default"
/// Never throws — a DB hiccup degrades to the built-ins so the clock keeps working.
export async function getPolicy(treatmentType: string): Promise<ResolvedPolicy> {
  const key = treatmentType || DEFAULT_POLICY_KEY;
  let row = await prisma.treatmentStagePolicy.findFirst({
    where: { treatmentType: key, active: true },
  });
  if (!row) {
    row = await prisma.treatmentStagePolicy.findFirst({ where: { isDefault: true, active: true } });
  }

  if (row) {
    const stageDays = parseStageDays(row.stageDays);
    const checkInDays = parseCheckInDays(row.checkInDays);
    // A row that parses to nothing usable shouldn't silently disable the clock —
    // fall back to the built-in numbers for whichever half is empty.
    const fallback = BUILT_IN[key] ?? BUILT_IN[DEFAULT_POLICY_KEY]!;
    return {
      treatmentType: key,
      label: row.label || policyLabel(key),
      stageDays: Object.keys(stageDays).length ? stageDays : fallback.stageDays,
      checkInDays: checkInDays.length ? checkInDays : fallback.checkInDays,
      builtIn: false,
    };
  }

  const built = BUILT_IN[key] ?? BUILT_IN[DEFAULT_POLICY_KEY]!;
  return {
    treatmentType: key,
    label: built.label,
    stageDays: built.stageDays,
    checkInDays: built.checkInDays,
    builtIn: true,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/// When a journey entering `stage` at `from` breaches its limit. Null = no limit
/// configured for that stage, i.e. it can never go overdue.
export function stageDueAt(policy: ResolvedPolicy, stage: string, from: Date): Date | null {
  const days = policy.stageDays[stage as JourneyStage];
  if (!days) return null;
  return new Date(from.getTime() + days * DAY_MS);
}

/// The built-in numbers for a key, for seeding a new policy row on the admin screen.
export function builtInPolicy(key: string): { label: string; stageDays: StageDays; checkInDays: number[] } {
  const built = BUILT_IN[key] ?? BUILT_IN[DEFAULT_POLICY_KEY]!;
  return { label: built.label, stageDays: { ...built.stageDays }, checkInDays: [...built.checkInDays] };
}
