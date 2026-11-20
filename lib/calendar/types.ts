// The shapes the personal calendar hands the browser (lib/calendar/service.ts →
// components/calendar). Plain data, ISO strings for instants, IST date keys for days.

export const CAL_VIEWS = [
  { key: "list", label: "List" },
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "timeline", label: "Timeline" },
] as const;
export type CalView = (typeof CAL_VIEWS)[number]["key"];

export const BLOCK_KINDS = ["training", "break", "unavailable", "other"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  training: "Training",
  break: "Lunch / dinner break",
  unavailable: "Unavailable",
  other: "Other",
};

export function isBlockKind(v: unknown): v is BlockKind {
  return typeof v === "string" && (BLOCK_KINDS as readonly string[]).includes(v);
}

export type CalAppointment = {
  kind: "appointment";
  id: string;
  startAt: string;
  endAt: string;
  /// The patient, or "Booked" when the viewer may not see who (another branch).
  title: string;
  detail: string;
  status: string;
  href: string;
};

export type CalFollowUp = {
  kind: "followup";
  id: string;
  leadId: string;
  at: string;
  title: string;
  leadName: string;
  overdue: boolean;
};

export type CalTask = {
  kind: "task";
  id: string;
  /// The IST date this occurrence falls on.
  occurrence: string;
  at: string;
  allDay: boolean;
  title: string;
  notes: string | null;
  repeat: string;
  done: boolean;
  overdue: boolean;
  /// Who set it, when it wasn't the person themselves.
  assignedBy: string | null;
  /// Set by the person whose calendar this is, for someone else (only on "Assigned by me").
  assignedTo: string | null;
  /// The viewer may tick it (the assignee or whoever set it).
  canTick: boolean;
  /// The viewer may delete it (whoever set it, or an admin).
  canDelete: boolean;
};

export type CalBlock = {
  kind: "block";
  id: string;
  startAt: string;
  endAt: string;
  blockKind: string;
  label: string;
  note: string | null;
  /// Mirrored as time off, so no patient can be booked with them in it.
  blocksBookings: boolean;
  canRemove: boolean;
};

export type CalendarData = {
  owner: { id: string; name: string; isSelf: boolean; hasResource: boolean; hasRep: boolean };
  fromKey: string;
  toKey: string;
  appointments: CalAppointment[];
  followUps: CalFollowUp[];
  tasks: CalTask[];
  blocks: CalBlock[];
  /// Open one-time tasks past due, from before the range too.
  overdueTasks: CalTask[];
  /// Pending lead follow-ups past due (all of them, not just in range).
  overdueFollowUps: number;
  /// Tasks this person set for colleagues that are still open.
  assignedByMe: CalTask[];
};
