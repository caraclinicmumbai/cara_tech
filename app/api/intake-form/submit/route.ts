// Submit an intake form (§2.7) — multipart, because it can carry photos (a route
// handler rather than a server action, so the photo bytes aren't squeezed through the
// action body limit). Public: authorised by the signed form link AND the signed
// verified-phone token from the OTP step. Rate-limited.
import { NextResponse } from "next/server";
import { getClientIp, rateLimit } from "@/lib/rateLimit";
import { readVerified } from "@/lib/scheduling/otp";
import { MAX_PHOTO_BYTES, submitIntake, type IntakePhotoUpload } from "@/lib/scheduling/intake/service";
import type { Answers } from "@/lib/scheduling/intake/schema";

export async function POST(req: Request) {
  const ip = getClientIp(req);
  if (!(await rateLimit(`intake-submit:${ip}`, 10, 900)).ok) {
    return NextResponse.json({ ok: false, errors: ["Too many attempts — please wait a few minutes."] }, { status: 429 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, errors: ["Couldn't read the form."] }, { status: 400 });
  }
  const token = String(form.get("token") ?? "");
  const verified = readVerified(String(form.get("verified") ?? ""), "intake_form");
  if (!verified) return NextResponse.json({ ok: false, errors: ["Please verify your mobile number again."] }, { status: 401 });
  let answers: Answers;
  try {
    answers = JSON.parse(String(form.get("answers") ?? "{}")) as Answers;
  } catch {
    return NextResponse.json({ ok: false, errors: ["Couldn't read your answers."] }, { status: 400 });
  }
  const photos: IntakePhotoUpload[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith("photo:") || typeof value === "string") continue;
    const [, field, slot] = name.split(":");
    if (value.size > MAX_PHOTO_BYTES) return NextResponse.json({ ok: false, errors: ["One of the photos is too large."] }, { status: 413 });
    photos.push({ field, slot, mime: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  const r = await submitIntake({ token, verifiedPhone: verified, answers, photos, ip, userAgent: req.headers.get("user-agent") });
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
