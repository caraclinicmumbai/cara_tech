// Appointment message text (§3.2 2.4) — the placeholder vocabulary, the filler, and
// the preset reminder timelines. PURE (no server imports) so the setup screen can
// preview a message in the browser with exactly the code that sends it.

export const TEMPLATE_VARIABLES = [
  "patient_name",
  "patient_full_name",
  "date",
  "time",
  "service",
  "doctor",
  "branch",
  "branch_address",
  "branch_phone",
  "map_link",
  "prep",
  "link",
  "clinic",
] as const;

export const SAMPLE_VARIABLES: Record<string, string> = {
  patient_name: "Priya",
  patient_full_name: "Priya Shah",
  date: "Thu, 2 Oct",
  time: "4:00 PM",
  service: "Hair Loss Consultation",
  doctor: "Dr Asif",
  branch: "Cara Powai",
  branch_address: "Hiranandani Gardens, Powai, Mumbai",
  branch_phone: "+91 22 6423 1017",
  map_link: "https://maps.google.com/?q=Cara+Powai",
  prep: "Wash your hair the night before. No blood thinners for 7 days.",
  link: "https://crm.caraclinics.com/a/…",
  clinic: "Cara Clinic",
};

/// Fill {placeholders}. An unknown placeholder is left visible (so a typo shows up in
/// the preview, not silently vanishes); an empty value removes a line that held only it.
export function fillTemplate(body: string, vars: Record<string, string>): string {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const filled = line.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
    // A line that only held placeholders which turned out empty disappears entirely;
    // a blank line the author wrote (a paragraph break) stays.
    if (/\{[a-z_]+\}/.test(line) && filled.trim() === "") continue;
    out.push(filled);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Presets (2.4.a — the spec's example timelines) ───────────────────────────

export type RulePreset = {
  kind: "on_booking" | "before" | "morning_of";
  minutesBefore?: number;
  atMin?: number;
  templateKey: string;
  channels: string[];
  quietExempt?: boolean;
};

export const REMINDER_PRESETS: Record<string, { label: string; cutoffHours: number; rules: RulePreset[] }> = {
  consultation: {
    label: "Consultation — confirmation, 24 h and 2 h before",
    cutoffHours: 4,
    rules: [
      { kind: "on_booking", templateKey: "confirmation", channels: ["whatsapp"] },
      { kind: "before", minutesBefore: 24 * 60, templateKey: "reminder_24h", channels: ["whatsapp"] },
      { kind: "before", minutesBefore: 120, templateKey: "reminder_2h", channels: ["whatsapp"] },
    ],
  },
  treatment: {
    label: "Treatment / procedure — confirmation and 24 h before",
    cutoffHours: 24,
    rules: [
      { kind: "on_booking", templateKey: "confirmation", channels: ["whatsapp"] },
      { kind: "before", minutesBefore: 24 * 60, templateKey: "reminder_24h", channels: ["whatsapp"] },
    ],
  },
  surgery: {
    label: "Surgery — 7 days (+ email checklist), 72 h, 24 h, morning-of",
    cutoffHours: 72,
    rules: [
      { kind: "on_booking", templateKey: "confirmation", channels: ["whatsapp"] },
      { kind: "before", minutesBefore: 7 * 24 * 60, templateKey: "surgery_7d", channels: ["whatsapp", "email"] },
      { kind: "before", minutesBefore: 72 * 60, templateKey: "surgery_3d", channels: ["whatsapp"] },
      { kind: "before", minutesBefore: 24 * 60, templateKey: "surgery_1d", channels: ["whatsapp", "sms"] },
      { kind: "morning_of", atMin: 6 * 60 + 30, templateKey: "surgery_morning", channels: ["whatsapp"], quietExempt: true },
    ],
  },
};

