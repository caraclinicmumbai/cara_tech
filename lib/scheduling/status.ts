// Appointment status lifecycle (§3.2 1.5, Decision 1.A — adopted as written).
// Reports and automations (reminders, no-show tracking) depend on these being the
// same everywhere, so the keys and the allowed moves live here and nowhere else.

export const APPOINTMENT_STATUSES = [
  "tentative",
  "booked",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
  "rescheduled",
  "cancelled",
  "no_show",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  tentative: "Tentative / Held",
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked-in",
  in_progress: "In progress",
  completed: "Completed",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  no_show: "No-show",
};

/// Where an appointment may go from each status. `rescheduled` is reached only
/// through rescheduleAppointment() (it creates the replacement row), never by a
/// plain status change — so it isn't listed as a target here.
export const STATUS_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  tentative: ["booked", "cancelled"],
  booked: ["confirmed", "checked_in", "cancelled", "no_show"],
  confirmed: ["checked_in", "cancelled", "no_show", "booked"],
  // A patient who arrived and then left before being seen is a cancellation, not a
  // no-show — they did come.
  checked_in: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed"],
  completed: [],
  rescheduled: [],
  cancelled: [],
  no_show: [],
};

/// Statuses that may still be rescheduled.
export const RESCHEDULABLE: readonly AppointmentStatus[] = ["tentative", "booked", "confirmed"];

/// Final statuses — nothing moves out of them.
export const TERMINAL: readonly AppointmentStatus[] = ["completed", "rescheduled", "cancelled", "no_show"];

/// Statuses in which the appointment no longer holds its resources.
export const RELEASES_RESOURCES: readonly AppointmentStatus[] = ["rescheduled", "cancelled", "no_show"];

export function isAppointmentStatus(v: string): v is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(v);
}

export function canTransition(from: string, to: string): boolean {
  if (!isAppointmentStatus(from) || !isAppointmentStatus(to)) return false;
  return STATUS_TRANSITIONS[from].includes(to);
}

/// The timestamp column stamped on entering a status.
export const STATUS_STAMP: Partial<Record<AppointmentStatus, string>> = {
  confirmed: "confirmedAt",
  checked_in: "checkedInAt",
  in_progress: "startedAt",
  completed: "completedAt",
  cancelled: "cancelledAt",
  no_show: "noShowAt",
};

export const APPOINTMENT_SOURCES = ["front_desk", "call_centre", "online", "walk_in", "series", "import"] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

export const RESOURCE_KINDS = ["doctor", "room", "equipment", "staff"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  doctor: "Doctor",
  room: "Room",
  equipment: "Equipment",
  staff: "Support staff",
};

export function isResourceKind(v: string): v is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(v);
}
