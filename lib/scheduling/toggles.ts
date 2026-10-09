// The on/off switches for the scheduling module (§3.2 — "everything in the system
// should be turned on or off with a toggle"). Global, not per branch (decided
// 2026-10-08). Stored as AppSetting rows via lib/settings.ts, edited on the
// Scheduling setup screen, every change audited.
//
// A switch is only listed here once the code honours it — a toggle that does nothing
// is worse than no toggle, because someone will flip it during an incident.

export type SchedulingToggle = {
  key: string;
  label: string;
  description: string;
  default: boolean;
};

export const SCHEDULING_ENABLED = "scheduling.enabled";
export const ALLOW_DOCTOR_DOUBLE_BOOKING = "scheduling.allowDoctorDoubleBooking";
export const ENFORCE_BRANCH_HOURS = "scheduling.enforceBranchHours";
export const ENFORCE_STAFF_ROSTERS = "scheduling.enforceStaffRosters";
export const REQUIRE_SUPPORT_STAFF = "scheduling.requireSupportStaff";
export const BLOCK_EQUIPMENT = "scheduling.blockEquipment";
export const PATIENT_FLAGS_ENABLED = "scheduling.patientFlags";
export const REMINDERS_ENABLED = "scheduling.remindersEnabled";
export const SELF_SERVICE_LINKS = "scheduling.selfServiceLinks";
export const ONLINE_BOOKING = "scheduling.onlineBooking";
export const RECALL_ENABLED = "scheduling.recallEnabled";

export const SCHEDULING_TOGGLES: SchedulingToggle[] = [
  {
    key: SCHEDULING_ENABLED,
    label: "Appointments module",
    description:
      "Master switch. Off: nothing can be booked, moved or checked in, and the module is hidden from the menu. Existing appointments are kept.",
    default: true,
  },
  {
    key: ALLOW_DOCTOR_DOUBLE_BOOKING,
    label: "Allow doctors to be double-booked",
    description:
      "On: booking a doctor who already has a patient at that time shows a warning that must be acknowledged, and the overbooking is recorded. Off: a doctor is blocked like a room. Rooms and the OT team are never double-booked either way.",
    default: true,
  },
  {
    key: BLOCK_EQUIPMENT,
    label: "Block equipment like rooms",
    description:
      "Off (the clinic's choice, §2.1): a machine already in use or under maintenance shows a warning that must be acknowledged, but doesn't stop the booking. On: equipment is blocked like a room — no double-booking, no booking during downtime.",
    default: false,
  },
  {
    key: ENFORCE_BRANCH_HOURS,
    label: "Enforce branch hours and holidays",
    description:
      "On: no appointment outside a branch's opening hours or on a holiday / blackout date. Off: the hours are shown as a guide only.",
    default: true,
  },
  {
    key: ENFORCE_STAFF_ROSTERS,
    label: "Enforce doctor & staff rosters and leave",
    description:
      "On: a doctor or staff member can only be booked inside their weekly roster at that branch, and never during leave / time off. Off: rosters are a guide only (leave still warns).",
    default: true,
  },
  {
    key: REQUIRE_SUPPORT_STAFF,
    label: "Schedule support staff",
    description:
      "On: appointment types that need the OT team (technicians, nurses, an anaesthetist) reserve them, and can't be booked when the team isn't free. Off: staff requirements are ignored.",
    default: true,
  },
  {
    key: REMINDERS_ENABLED,
    label: "Send appointment reminders",
    description:
      "Off until the WhatsApp templates are approved and the clinic is ready (§2.4). While off, nothing is sent to patients, and reminders that fall due are marked skipped rather than saved up — switching on never sends a backlog.",
    default: false,
  },
  {
    key: SELF_SERVICE_LINKS,
    label: "Patient self-service link",
    description:
      "Reminders carry a secure link where the patient can confirm, reschedule or cancel, within each appointment type's self-service cut-off. Off: the link page only shows the appointment and asks them to call.",
    default: true,
  },
  {
    key: ONLINE_BOOKING,
    label: "Online booking widget",
    description:
      "The public booking page (/book) patients reach from the website. Only appointment types marked online-bookable appear; surgery never does (§2.3). Off: the page says to call the clinic.",
    default: true,
  },
  {
    key: RECALL_ENABLED,
    label: "Treatment-plan recall messages",
    description:
      "When a planned session's window opens and it isn't booked: WhatsApp on the day, WhatsApp + SMS three days later, a call task at seven days (§2.8.d). Off until the recall WhatsApp template is approved. The recall list works either way.",
    default: false,
  },
  {
    key: PATIENT_FLAGS_ENABLED,
    label: "Patient flags",
    description: "Show flags such as ★ Priority on patient cards, and let staff set them.",
    default: true,
  },
];

export const SCHEDULING_TOGGLE_DEFAULTS: Record<string, boolean> = Object.fromEntries(
  SCHEDULING_TOGGLES.map((t) => [t.key, t.default]),
);

export function isSchedulingToggle(key: string): boolean {
  return key in SCHEDULING_TOGGLE_DEFAULTS;
}

// ── Numeric settings (same store, same audit) ────────────────────────────────

export type SchedulingNumber = {
  key: string;
  label: string;
  description: string;
  unit: string;
  default: number;
  min: number;
  max: number;
};

export const DEFAULT_TRAVEL_MINUTES = "scheduling.defaultTravelMinutes";
export const QUIET_START_HOUR = "scheduling.quietStartHour";
export const QUIET_END_HOUR = "scheduling.quietEndHour";
export const ONLINE_MIN_NOTICE_HOURS = "scheduling.onlineMinNoticeHours";
export const ONLINE_MAX_DAYS = "scheduling.onlineMaxDays";
export const ONLINE_HOLD_MINUTES = "scheduling.onlineHoldMinutes";

export const SCHEDULING_NUMBERS: SchedulingNumber[] = [
  {
    key: DEFAULT_TRAVEL_MINUTES,
    label: "Default travel time between branches",
    description:
      "Used for any pair of branches without its own time in the travel matrix. A doctor or staff member can't be booked at a second branch the same day unless this much time separates the two (§2.2.a).",
    unit: "min",
    default: 90,
    min: 0,
    max: 600,
  },
  {
    key: QUIET_START_HOUR,
    label: "Reminder quiet hours start",
    description: "No reminders from this hour (IST, 24h clock) — except those marked quiet-exempt, like the morning-of-surgery reminder (§2.4.f).",
    unit: "h",
    default: 21,
    min: 0,
    max: 23,
  },
  {
    key: QUIET_END_HOUR,
    label: "Reminder quiet hours end",
    description: "Reminders held overnight go out from this hour (IST).",
    unit: "h",
    default: 8,
    min: 0,
    max: 23,
  },
  {
    key: ONLINE_MIN_NOTICE_HOURS,
    label: "Online booking — minimum notice",
    description: "Patients can't book online for a time sooner than this (§2.3.d).",
    unit: "h",
    default: 3,
    min: 0,
    max: 168,
  },
  {
    key: ONLINE_MAX_DAYS,
    label: "Online booking — how far ahead",
    description: "Patients can book online up to this many days ahead (§2.3.d).",
    unit: "days",
    default: 90,
    min: 1,
    max: 365,
  },
  {
    key: ONLINE_HOLD_MINUTES,
    label: "Online booking — slot hold",
    description: "A picked slot is held this long while the patient fills in their details (§2.3).",
    unit: "min",
    default: 10,
    min: 3,
    max: 30,
  },
];

export const SCHEDULING_NUMBER_DEFAULTS: Record<string, number> = Object.fromEntries(
  SCHEDULING_NUMBERS.map((n) => [n.key, n.default]),
);
