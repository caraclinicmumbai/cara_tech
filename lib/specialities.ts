// Sales-rep specialities (§presence). The clinic works three treatment areas, so a
// rep's skill is one of them rather than free text — a typo'd "hair transplant" would
// never match "Hair" when `pickReplacementFor()` looks for a colleague with the same
// speciality to cover an offline counsellor's leads (lib/salesReps.ts).
//
// Pure constants, no imports: this module is used by the admin client component AND by
// the server action that validates what it sends.

export const SPECIALITIES = ["Hair", "Skin", "Face"] as const;

export type Speciality = (typeof SPECIALITIES)[number];

/// True for one of the three canonical specialities. A blank speciality is valid too
/// (a generalist), but it isn't a Speciality — callers handle "" / null themselves.
export function isSpeciality(v: string): v is Speciality {
  return (SPECIALITIES as readonly string[]).includes(v);
}

/// Label for a stored value. Reps created before the list existed can hold arbitrary
/// text (e.g. "hair transplant"); those are shown as-is and marked, so the dropdown
/// tells the truth instead of silently reading as one of the three or as generalist.
export function specialityLabel(v: string | null): string {
  if (!v) return "Generalist";
  return isSpeciality(v) ? v : `${v} (unrecognised)`;
}
