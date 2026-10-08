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
