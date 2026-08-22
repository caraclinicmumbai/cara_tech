// Auto-filling WhatsApp template variables from the lead on screen (§3.1.3).
//
// An approved template body is written as "Hi {{1}}, your {{2}} consultation at
// {{3}}…". A telecaller re-opening a closed 24h window shouldn't have to retype
// the patient's own name — everything we already know about the lead should land
// in the right slot, leaving them only the genuinely unknown values.
//
// Pure functions with no server imports so the picker (a client component) can
// use them directly. The mapping is a best guess from the words immediately
// before each placeholder; the agent can always overwrite a filled value.

/// What we know about the lead, for filling a template's variables.
export type LeadTemplateContext = {
  name: string;
  phone: string;
  interest?: string | null; // free-text interest from intake, e.g. "Hair treatment"
  treatment?: string | null; // what they asked for on the call (Lead.tag)
  repName?: string | null; // assigned sales rep
  branchName?: string | null; // the lead's branch, when set
  clinicName: string;
};

/// First name only — "Hi Rajesh Kumar," reads worse than "Hi Rajesh,".
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? "";
}

/// Where a filled value came from, so the picker can label the input.
export type ParamSource = "name" | "treatment" | "clinic" | "rep" | "phone" | "manual";

export type SuggestedParam = { value: string; source: ParamSource };

// Each rule tests the text just BEFORE a {{n}} placeholder. First match wins, so
// the more specific patterns (a greeting, an explicit "your <treatment>") come
// before the general ones.
const RULES: { test: RegExp; source: ParamSource }[] = [
  { test: /\b(hi|hello|hey|dear|namaste|greetings)\b[\s,.!:—-]*$/i, source: "name" },
  { test: /\b(name|patient|mr|mrs|ms|sir|madam)\b[\s,.!:—-]*$/i, source: "name" },
  { test: /\b(treatment|procedure|surgery|service|package|consultation for|interested in)\b[\s,.!:—-]*$/i, source: "treatment" },
  { test: /\b(clinic|branch|centre|center|location|at)\b[\s,.!:—-]*$/i, source: "clinic" },
  { test: /\b(rep|consultant|counsellor|counselor|advisor|executive|manager|team|from|regards|this is)\b[\s,.!:—-]*$/i, source: "rep" },
  { test: /\b(number|phone|mobile|contact|whatsapp|call us on|reach us at)\b[\s,.!:—-]*$/i, source: "phone" },
];

const LOOKBACK = 48; // chars of context before a placeholder that we read

function valueFor(source: ParamSource, ctx: LeadTemplateContext): string {
  switch (source) {
    case "name":
      return firstName(ctx.name);
    case "treatment":
      return (ctx.treatment || ctx.interest || "").trim();
    case "clinic":
      return (ctx.branchName || ctx.clinicName).trim();
    case "rep":
      return (ctx.repName || "").trim();
    case "phone":
      return ctx.phone.trim();
    case "manual":
      return "";
  }
}

/// Guess a value for every {{n}} in `bodyText`, in order. Index 0 defaults to the
/// patient's first name (overwhelmingly the convention in approved templates)
/// when no rule matches; later slots are left blank for the agent to fill.
export function suggestTemplateParams(
  bodyText: string,
  ctx: LeadTemplateContext,
  count: number,
): SuggestedParam[] {
  const out: SuggestedParam[] = Array.from({ length: count }, () => ({ value: "", source: "manual" as ParamSource }));

  for (const m of bodyText.matchAll(/\{\{(\d+)\}\}/g)) {
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= count || out[idx].value) continue;
    const before = bodyText.slice(Math.max(0, m.index - LOOKBACK), m.index);

    let source: ParamSource = "manual";
    for (const rule of RULES) {
      if (rule.test.test(before)) {
        source = rule.source;
        break;
      }
    }
    // A leading variable with no clue around it is the patient's name.
    if (source === "manual" && idx === 0) source = "name";

    const value = valueFor(source, ctx);
    out[idx] = value ? { value, source } : { value: "", source: "manual" };
  }

  return out;
}

/// Human label for a filled slot, shown next to the input.
export const SOURCE_LABELS: Record<ParamSource, string> = {
  name: "patient name",
  treatment: "treatment",
  clinic: "clinic",
  rep: "sales rep",
  phone: "phone",
  manual: "",
};

/// Preview of the message the patient will receive: the body with values
/// substituted. Unfilled placeholders stay visible as {{n}}.
export function previewTemplate(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => {
    const v = params[Number(n) - 1];
    return v && v.trim() ? v.trim() : whole;
  });
}
