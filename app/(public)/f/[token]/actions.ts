"use server";

// The intake form's code step (§2.7). The code goes to the mobile number ON FILE for
// the appointment — the patient never types a number here, so a forwarded link can't
// be opened by someone else. Only after the code is right do we hand back the form and
// any answers carried over from last time.
import { headers } from "next/headers";
import { issueOtp, verifyOtp } from "@/lib/scheduling/otp";
import { intakeContext, prefillFor } from "@/lib/scheduling/intake/service";
import type { Answers, IntakeSchema } from "@/lib/scheduling/intake/schema";

async function ip() {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function sendIntakeCode(token: string): Promise<{ ok: boolean; error?: string; devCode?: string }> {
  const ctx = await intakeContext(token);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (ctx.submitted) return { ok: false, error: "This form has already been completed — thank you." };
  const r = await issueOtp(ctx.phone, "intake_form", await ip());
  return r.ok ? { ok: true, devCode: r.devCode } : { ok: false, error: r.error };
}

export async function verifyIntakeCode(
  token: string,
  code: string,
): Promise<{ ok: true; verifiedToken: string; schema: IntakeSchema; prefill: Answers } | { ok: false; error: string }> {
  const ctx = await intakeContext(token);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const r = await verifyOtp(ctx.phone, "intake_form", code);
  if (!r.ok) return r;
  return { ok: true, verifiedToken: r.token, schema: ctx.schema, prefill: await prefillFor(ctx.leadId, ctx.formId, ctx.schema) };
}
