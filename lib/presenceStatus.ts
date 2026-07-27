// Counsellor availability (§presence "Knowing who's available") — PURE constants
// shared by the client (the one-tap status switcher) and the server (routing +
// presence logic). Keep this file free of server-only imports (prisma, slack,
// audit…) so it's safe to pull into a "use client" component.

export const AVAILABILITY = [
  {
    value: "available",
    label: "Active",
    dot: "bg-emerald-500",
    hint: "Receiving new leads",
  },
  {
    value: "in_consultation",
    label: "In Consultation",
    dot: "bg-amber-500",
    hint: "On a call — new leads go to the next available counsellor",
  },
  {
    value: "break",
    label: "On Break",
    dot: "bg-sky-500",
    hint: "Away briefly — new leads go to the next available counsellor",
  },
  {
    value: "offline",
    label: "Offline",
    dot: "bg-zinc-400",
    hint: "Off the floor — leads route to a colleague with the same speciality",
  },
] as const;

export type Availability = (typeof AVAILABILITY)[number]["value"];

export const AVAILABILITY_VALUES = AVAILABILITY.map((a) => a.value) as Availability[];

export function isAvailability(v: string | null | undefined): v is Availability {
  return !!v && (AVAILABILITY_VALUES as string[]).includes(v);
}

/// The display metadata for a status value (falls back to "Active" for unknown values).
export function availabilityMeta(v: string) {
  return AVAILABILITY.find((a) => a.value === v) ?? AVAILABILITY[0];
}

export function availabilityLabel(v: string): string {
  return availabilityMeta(v).label;
}
