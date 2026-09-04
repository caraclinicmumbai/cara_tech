// The working queue: the leads a telecaller is currently going through (§leads table).
//
// A telecaller filters the leads table down to today's work — say "follow-up due today,
// unowned" — opens the first one, calls it, and then has to go back, re-apply the
// filter, find where they were and open the next. Over forty leads that's forty round
// trips through a filter panel.
//
// So the table hands the lead page its list. The IDs are stored in **sessionStorage**
// rather than in the URL or the database: it's per-tab (two windows can work two
// different filters), it survives navigation, it dies with the tab, and it carries no
// patient data beyond ids the user just looked at.
//
// Deliberately dumb about staleness. The queue is a snapshot of what the filter matched
// when they clicked in; a lead whose stage changed since is still in it. Re-running the
// filter on every "next" would silently drop leads out from under someone mid-call,
// which is worse than a slightly stale list they can see the length of.

const KEY = "cara:leadQueue";

/// How long a queue stays usable. Long enough for a calling session, short enough that
/// yesterday's tab doesn't resume into a list that no longer means anything.
const MAX_AGE_MS = 8 * 60 * 60_000;

export type LeadQueue = {
  /// Lead ids in the order the table showed them, after filtering and sorting.
  ids: string[];
  /// What the filter was, in words, so the lead page can say what it's stepping through.
  label: string;
  /// When it was captured (epoch ms).
  at: number;
};

// Read through useSyncExternalStore rather than an effect-plus-setState: the queue is
// external state the server can't see, and that hook is React's way of saying so. It
// also means the snapshot must be PURE and referentially stable — hence the cache below,
// and hence nothing here writes to storage while reading it.

let cachedRaw: string | null = null;
let cachedValue: LeadQueue | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function parse(raw: string | null): LeadQueue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LeadQueue;
    if (!Array.isArray(parsed.ids) || parsed.ids.length < 2) return null;
    // Expiry is judged, not enforced, here — deleting during a render read would be a
    // side effect in a place React requires purity. A stale queue simply reads as none.
    if (!parsed.at || Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveLeadQueue(queue: Omit<LeadQueue, "at">): void {
  if (typeof window === "undefined") return;
  try {
    // A queue of one is just the lead you clicked — nothing to step through.
    if (queue.ids.length < 2) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify({ ...queue, at: Date.now() }));
    emit();
  } catch {
    // Private mode / quota — the nav just won't appear. Never break navigation for it.
  }
}

export function clearLeadQueue(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
    emit();
  } catch {
    /* ignore */
  }
}

/// Subscribe to queue changes. `storage` covers other tabs; `emit` covers this one.
export function subscribeLeadQueue(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/// The current queue. Pure, and returns the SAME object while the stored string is
/// unchanged — React re-reads this on every render and would loop on a fresh object.
export function getLeadQueueSnapshot(): LeadQueue | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parse(raw);
  }
  return cachedValue;
}

/// Server render: there is no sessionStorage, so there is no queue.
export function getLeadQueueServerSnapshot(): LeadQueue | null {
  return null;
}

/// Where a lead sits in the queue, and what's on either side. Null when this lead isn't
/// part of the queue at all — opened from a search, a bell, or a link.
export function positionIn(
  queue: LeadQueue | null,
  leadId: string,
): { index: number; total: number; prevId: string | null; nextId: string | null } | null {
  if (!queue) return null;
  const index = queue.ids.indexOf(leadId);
  if (index < 0) return null;
  return {
    index,
    total: queue.ids.length,
    prevId: index > 0 ? queue.ids[index - 1] : null,
    nextId: index < queue.ids.length - 1 ? queue.ids[index + 1] : null,
  };
}
