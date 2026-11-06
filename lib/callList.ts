// The call log, one page at a time (§calls). It used to show the newest 100 calls and
// nothing else, so a call from last month simply wasn't there. Now every call the viewer
// may see is reachable: the filters live in the URL, this module turns them into one
// Prisma `where`, and the page loads the 50 rows on screen — the same shape as the leads
// table (lib/leadList.ts).
//
//   /calls?q=priya&status=connected&rep=<id>&rep=ai&from=2026-11-01T10:00&page=2
import type { Prisma } from "@prisma/client";

export const CALLS_PAGE_SIZE = 50;

/// What a call counts as in the Status filter. A call "connected" when somebody spoke:
/// a click-to-call or clinic-line call that connected, or an AI call that reached a
/// decision. Older counsellor calls carry no outcome, only a duration.
export const CALL_STATUSES = ["connected", "not_connected"] as const;
export const CALL_STATUS_LABELS: Record<(typeof CALL_STATUSES)[number], string> = {
  connected: "Connected",
  not_connected: "Not connected",
};
const CONNECTED_OUTCOMES = ["connected", "confirmed", "rescheduled", "not_interested"];

/// The Status filter's definition for a row already in hand (statusWhere below is the same
/// rule as a query), so the reports and the call log can't disagree on what connected.
export function isConnectedCall(call: { outcome: string | null; duration: number | null }): boolean {
  if (call.outcome) return CONNECTED_OUTCOMES.includes(call.outcome);
  return (call.duration ?? 0) > 0;
}

export const CALL_KINDS = ["ai", "counsellor", "ivr_incoming", "ivr_missed"] as const;
export const CALL_KIND_LABELS: Record<(typeof CALL_KINDS)[number], string> = {
  ai: "AI call",
  counsellor: "Counsellor call",
  ivr_incoming: "IVR Incoming",
  ivr_missed: "IVR Missed",
};

/// The Team member filter's value for calls no person handled.
export const AI_REP = "ai";

export type CallListFilters = {
  q: string;
  kinds: string[];
  statuses: string[];
  reps: string[];
  /// "YYYY-MM-DDTHH:mm" in IST, as a datetime-local input speaks.
  from: string;
  to: string;
  page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

const all = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
const one = (v: string | string[] | undefined): string => all(v)[0] ?? "";
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/// Read the filters out of searchParams. Anything malformed is dropped, never thrown on.
export function parseCallListParams(params: RawParams): CallListFilters {
  const from = one(params.from);
  const to = one(params.to);
  const page = parseInt(one(params.page), 10);
  return {
    q: one(params.q).slice(0, 100),
    kinds: all(params.kind),
    statuses: all(params.status),
    reps: all(params.rep),
    from: MOMENT.test(from) ? from : "",
    to: MOMENT.test(to) ? to : "",
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/// The same filters as a query string.
export function callListQuery(f: CallListFilters): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const v of f.kinds) p.append("kind", v);
  for (const v of f.statuses) p.append("status", v);
  for (const v of f.reps) p.append("rep", v);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

const IVR_MISSED_OUTCOMES = ["missed", "voicemail"];

function kindWhere(kind: string): Prisma.CallWhereInput | null {
  switch (kind) {
    case "ai":
      return { callType: { in: ["initial", "reconfirmation"] } };
    case "counsellor":
      return { callType: "human_handover" };
    case "ivr_missed":
      return {
        OR: [{ callType: "inbound_voicemail" }, { callType: "inbound", outcome: { in: IVR_MISSED_OUTCOMES } }],
      };
    case "ivr_incoming":
      // `notIn` alone would drop a row whose outcome is still empty.
      return { callType: "inbound", OR: [{ outcome: null }, { outcome: { notIn: IVR_MISSED_OUTCOMES } }] };
    default:
      return null;
  }
}

/// Spelt out both ways rather than NOT-ing one side: SQL's NOT over a NULL outcome is NULL,
/// which would quietly leave those calls out of "Not connected".
function statusWhere(status: string): Prisma.CallWhereInput | null {
  if (status === "connected") {
    return { OR: [{ outcome: { in: CONNECTED_OUTCOMES } }, { outcome: null, duration: { gt: 0 } }] };
  }
  if (status === "not_connected") {
    return {
      OR: [
        { outcome: { notIn: CONNECTED_OUTCOMES } },
        { outcome: null, OR: [{ duration: null }, { duration: { lte: 0 } }] },
      ],
    };
  }
  return null;
}

const anyOf = (wheres: (Prisma.CallWhereInput | null)[]): Prisma.CallWhereInput[] => {
  const known = wheres.filter((w): w is Prisma.CallWhereInput => !!w);
  return known.length ? [{ OR: known }] : [];
};

/// The Prisma `where` for these filters. `leadScope` is who may see which leads.
export function callListWhere(f: CallListFilters, leadScope: Prisma.LeadWhereInput): Prisma.CallWhereInput {
  const and: Prisma.CallWhereInput[] = [{ lead: { deletedAt: null, ...leadScope } }];

  const q = f.q.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    and.push({
      lead: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
        ],
      },
    });
  }
  and.push(...anyOf(f.kinds.map(kindWhere)));
  and.push(...anyOf(f.statuses.map(statusWhere)));
  if (f.reps.length) {
    const ids = f.reps.filter((r) => r !== AI_REP);
    and.push({
      OR: [
        ...(ids.length ? [{ handledById: { in: ids } }] : []),
        ...(f.reps.includes(AI_REP) ? [{ handledById: null }] : []),
      ],
    });
  }
  // Typed as IST, whatever the server's or the browser's clock says.
  if (f.from) and.push({ createdAt: { gte: new Date(`${f.from}:00+05:30`) } });
  if (f.to) and.push({ createdAt: { lte: new Date(`${f.to}:59.999+05:30`) } });
  return { AND: and };
}

export function callListFiltered(f: CallListFilters): boolean {
  return !!(f.q.trim() || f.kinds.length || f.statuses.length || f.reps.length || f.from || f.to);
}
