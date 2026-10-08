// Intake form schema (§2.7) — the shape of a form, conditional logic, red flags and
// answer validation. PURE (no server imports): the public form renders with it, the
// server validates a submission with it, and the setup builder edits it — one
// definition of "what this form asks and what counts as a red flag".

export const FIELD_TYPES = ["text", "textarea", "number", "date", "yesno", "select", "multiselect", "photos", "consent", "info"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Short answer",
  textarea: "Long answer",
  number: "Number",
  date: "Date",
  yesno: "Yes / No",
  select: "Choose one",
  multiselect: "Choose any",
  photos: "Photos (guided)",
  consent: "Consent tick-box",
  info: "Information text",
};

export type FieldOption = { value: string; label: string; redFlag?: boolean };

/// Show this field only when another answer matches — "Diabetic? → Yes → HbA1c".
/// `under18` is special: shown when the date-of-birth field says the patient is a minor
/// (2.7.e guardian details).
export type ShowIf = { field: string; equals?: string } | { under18: true };

export type IntakeField = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  options?: FieldOption[];
  /// yes/no: a "yes" is a red flag (blood thinners, bleeding disorder…).
  redFlagWhenYes?: boolean;
  showIf?: ShowIf;
  /// consent: which purpose this tick records (ConsentRecord.purpose) — each separate.
  consentPurpose?: string;
  /// photos: the guided angles.
  photoSlots?: string[];
  /// Hint for the EMR (3.3) mapping: allergies | medications | conditions.
  emr?: string;
};

export type IntakeSection = { id: string; title: string; fields: IntakeField[] };
export type IntakeSchema = { sections: IntakeSection[] };

export type Answers = Record<string, string | string[] | boolean | undefined>;

export const PHOTO_SLOT_LABELS: Record<string, string> = {
  front: "Front hairline",
  top: "Top of the head",
  crown: "Crown (back of the top)",
  donor: "Back of the head (donor area)",
  left: "Left side",
  right: "Right side",
};

export function ageFrom(dob: string, today = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split("-").map(Number);
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age;
}

/// The date-of-birth field, if the form has one (type date, key "dob").
function dobOf(answers: Answers): string | null {
  const v = answers.dob;
  return typeof v === "string" ? v : null;
}

export function isVisible(field: IntakeField, answers: Answers): boolean {
  const c = field.showIf;
  if (!c) return true;
  if ("under18" in c) {
    const dob = dobOf(answers);
    const age = dob ? ageFrom(dob) : null;
    return age !== null && age < 18;
  }
  const v = answers[c.field];
  if (c.equals === undefined) return v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0);
  return Array.isArray(v) ? v.includes(c.equals) : String(v ?? "") === c.equals;
}

/// Field keys whose (visible) answers are red flags.
export function redFlagsOf(schema: IntakeSchema, answers: Answers): string[] {
  const out: string[] = [];
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (!isVisible(f, answers)) continue;
      const v = answers[f.key];
      if (f.type === "yesno" && f.redFlagWhenYes && v === "yes") out.push(f.key);
      if ((f.type === "select" || f.type === "multiselect") && f.options?.length) {
        const chosen = Array.isArray(v) ? v : v ? [String(v)] : [];
        if (f.options.some((o) => o.redFlag && chosen.includes(o.value))) out.push(f.key);
      }
    }
  }
  return out;
}

/// Problems with a submission (missing required, bad values). Empty = fine. Hidden
/// fields are ignored — a question that wasn't shown can't be required.
export function validateAnswers(schema: IntakeSchema, answers: Answers, photoCounts: Record<string, number> = {}): string[] {
  const errors: string[] = [];
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (f.type === "info" || !isVisible(f, answers)) continue;
      const v = answers[f.key];
      const empty = v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0);
      if (f.type === "photos") {
        if (f.required && !(photoCounts[f.key] > 0)) errors.push(`${f.label}: please add at least one photo`);
        continue;
      }
      if (f.required && empty) {
        errors.push(f.type === "consent" ? `Please tick: ${f.label}` : `${f.label} is required`);
        continue;
      }
      if (empty) continue;
      if (f.type === "number" && Number.isNaN(Number(v))) errors.push(`${f.label} must be a number`);
      if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors.push(`${f.label} must be a date`);
      if (f.type === "select" && f.options && !f.options.some((o) => o.value === v)) errors.push(`${f.label}: pick an option`);
    }
  }
  return errors;
}

/// Is a stored schema well-formed? Returns problems for the builder to show.
export function checkSchema(schema: IntakeSchema): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  if (!schema.sections?.length) problems.push("Add at least one section");
  for (const s of schema.sections ?? []) {
    if (!s.title?.trim()) problems.push("Every section needs a title");
    for (const f of s.fields ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(f.key)) problems.push(`"${f.label}": the field key must be lowercase letters, numbers and _`);
      if (keys.has(f.key)) problems.push(`Two fields share the key "${f.key}"`);
      keys.add(f.key);
      if (!f.label?.trim()) problems.push(`Field "${f.key}" needs a label`);
      if ((f.type === "select" || f.type === "multiselect") && !(f.options?.length)) problems.push(`"${f.label}" needs options`);
      if (f.type === "consent" && !f.consentPurpose) problems.push(`"${f.label}": pick what the consent is for`);
      if (f.showIf && "field" in f.showIf && !keys.has(f.showIf.field)) problems.push(`"${f.label}" depends on "${f.showIf.field}", which must come earlier`);
    }
  }
  return problems;
}

export const CONSENT_PURPOSES = [
  { key: "treatment_photos", label: "Photos for treatment records" },
  { key: "marketing_photos", label: "Photos for marketing / website" },
  { key: "data_processing", label: "Processing my health information" },
  { key: "guardian", label: "Guardian consent (patient under 18)" },
] as const;

/// A starter form for a hair-loss consultation, from the spec's worked example. A
/// draft for the clinical lead (2.7.a, Jatin) to edit — not a clinical standard.
export const STARTER_HAIR_LOSS: IntakeSchema = {
  sections: [
    {
      id: "about",
      title: "About you",
      fields: [
        { key: "dob", label: "Date of birth", type: "date", required: true },
        { key: "guardian_name", label: "Parent / guardian's full name", type: "text", required: true, showIf: { under18: true } },
        { key: "guardian_relation", label: "Relationship to the patient", type: "text", required: true, showIf: { under18: true } },
        { key: "guardian_phone", label: "Guardian's mobile number", type: "text", required: true, showIf: { under18: true } },
        {
          key: "guardian_consent",
          label: "I am the patient's parent / legal guardian and I consent to this consultation and to the clinic processing their health information.",
          type: "consent",
          consentPurpose: "guardian",
          required: true,
          showIf: { under18: true },
        },
      ],
    },
    {
      id: "history",
      title: "Medical history",
      fields: [
        { key: "thyroid", label: "Do you have a thyroid condition?", type: "yesno", required: true, emr: "conditions" },
        { key: "thyroid_medication", label: "Medication name and dosage", type: "text", required: true, showIf: { field: "thyroid", equals: "yes" }, emr: "medications" },
        { key: "diabetes", label: "Are you diabetic?", type: "yesno", required: true, emr: "conditions" },
        { key: "diabetes_details", label: "Latest HbA1c and diabetes medication", type: "text", showIf: { field: "diabetes", equals: "yes" }, emr: "medications" },
        { key: "blood_thinners", label: "Do you take blood thinners (e.g. aspirin, warfarin)?", type: "yesno", required: true, redFlagWhenYes: true, emr: "medications" },
        { key: "bleeding_disorder", label: "Do you have a bleeding or clotting disorder?", type: "yesno", required: true, redFlagWhenYes: true, emr: "conditions" },
        { key: "keloid", label: "Do you form keloid (raised) scars?", type: "yesno", required: true, redFlagWhenYes: true, emr: "conditions" },
        { key: "allergies", label: "Allergies (including to anaesthetics) — or \"No known allergies\"", type: "text", required: true, emr: "allergies" },
        { key: "medications", label: "Other medicines you take regularly", type: "textarea", emr: "medications" },
      ],
    },
    {
      id: "hair",
      title: "Your hair",
      fields: [
        { key: "concern", label: "What would you like to improve?", type: "textarea", required: true },
        {
          key: "previous",
          label: "Previous hair treatments",
          type: "multiselect",
          options: [
            { value: "none", label: "None" },
            { value: "minoxidil", label: "Minoxidil" },
            { value: "finasteride", label: "Finasteride" },
            { value: "prp", label: "PRP" },
            { value: "transplant", label: "Hair transplant" },
          ],
        },
        { key: "photos", label: "Photos of your scalp (optional)", type: "photos", photoSlots: ["front", "top", "crown", "donor"], help: "In good light, hair dry, no styling products. One photo per angle." },
      ],
    },
    {
      id: "consents",
      title: "Consents",
      fields: [
        {
          key: "consent_data",
          label: "I agree that Cara Clinic may use the health information I've given here to plan and provide my care.",
          type: "consent",
          consentPurpose: "data_processing",
          required: true,
        },
        {
          key: "consent_treatment_photos",
          label: "I agree to photographs being taken and kept in my treatment record.",
          type: "consent",
          consentPurpose: "treatment_photos",
        },
        {
          key: "consent_marketing_photos",
          label: "I agree that my before/after photographs may be used on Cara Clinic's website and social media.",
          type: "consent",
          consentPurpose: "marketing_photos",
          help: "Separate from treatment photos, and entirely optional.",
        },
      ],
    },
  ],
};
