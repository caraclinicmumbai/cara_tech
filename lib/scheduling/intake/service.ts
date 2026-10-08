// Pre-consultation intake (§2.7). The link goes out with the booking confirmation and
// again in the day-before reminder if it isn't done ({intake_link}); the patient opens
// it, proves it's them with a code to the mobile on file (health data — 2.7 "use OTP
// when reopened"; it is also their acceptance of the consents, 2.7.f), and fills the
// form for their appointment type. Answers land as PATIENT-REPORTED until a clinician
// verifies them field by field; red-flag answers alert the doctor and branch manager.
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notifications";
import { phoneKey } from "@/lib/messages";
import { appBaseUrl } from "@/lib/scheduling/links";
import { redFlagsOf, validateAnswers, isVisible, type Answers, type IntakeSchema } from "@/lib/scheduling/intake/schema";

const LIVE = ["tentative", "booked", "confirmed", "checked_in"];
export const MAX_PHOTO_BYTES = 2_500_000;
export const MAX_PHOTOS = 8;

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

/// Signed, expiring: valid until a day after the appointment starts.
export function intakeToken(appointmentId: string, startAt: Date): string {
  const exp = Math.floor((startAt.getTime() + 86_400_000) / 1000).toString(36);
  const payload = `${appointmentId}.${exp}`;
  const sig = createHmac("sha256", secret()).update(`intake-link:${payload}`).digest("base64url").slice(0, 32);
  return `${payload}.${sig}`;
}

export function readIntakeToken(token: string): string | null {
  const [id, exp36, sig] = token.split(".");
  if (!id || !exp36 || !sig) return null;
  const expected = createHmac("sha256", secret()).update(`intake-link:${id}.${exp36}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(exp36, 36) * 1000 < Date.now()) return null;
  return id;
}

/// The form link for an appointment — or "" when its type has no form, or the form is
/// already done (so the {intake_link} line drops out of the message).
export async function intakeLinkFor(appointmentId: string): Promise<string> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { startAt: true, status: true, type: { select: { intakeForm: { select: { id: true, active: true, currentVersionId: true } } } } },
  });
  const form = a?.type.intakeForm;
  if (!a || !form?.active || !form.currentVersionId || !LIVE.includes(a.status)) return "";
  const done = await prisma.intakeResponse.count({ where: { appointmentId, formId: form.id } });
  return done ? "" : `${appBaseUrl()}/f/${intakeToken(appointmentId, a.startAt)}`;
}

export type IntakeContext = {
  appointmentId: string;
  leadId: string;
  phone: string;
  firstName: string;
  service: string;
  startAt: string;
  branch: string;
  formId: string;
  versionId: string;
  formName: string;
  schema: IntakeSchema;
  submitted: boolean;
};

export async function intakeContext(token: string): Promise<IntakeContext | { error: string }> {
  const id = readIntakeToken(token);
  if (!id) return { error: "This link has expired. Please ask the clinic to send it again." };
  const a = await prisma.appointment.findUnique({
    where: { id },
    include: {
      lead: { select: { id: true, name: true, phone: true } },
      branch: { select: { name: true } },
      type: { select: { name: true, intakeForm: { include: { versions: { orderBy: { version: "desc" }, take: 1 } } } } },
    },
  });
  if (!a) return { error: "Appointment not found." };
  const form = a.type.intakeForm;
  const version = form?.versions.find((v) => v.id === form.currentVersionId) ?? form?.versions[0];
  if (!form || !form.active || !version) return { error: "There's no form to fill for this appointment." };
  const submitted = (await prisma.intakeResponse.count({ where: { appointmentId: a.id, formId: form.id } })) > 0;
  return {
    appointmentId: a.id,
    leadId: a.lead.id,
    phone: a.lead.phone,
    firstName: a.lead.name.trim().split(/\s+/)[0] ?? "",
    service: a.type.name,
    startAt: a.startAt.toISOString(),
    branch: a.branch.name,
    formId: form.id,
    versionId: version.id,
    formName: form.name,
    schema: version.schema as unknown as IntakeSchema,
    submitted,
  };
}

/// What a returning patient answered last time on this form — pre-filled so they only
/// confirm or update (2.7 "reuse for returning patients"). Consents and photos are
/// never carried over: those are asked fresh every time. Only ever returned AFTER the
/// patient has verified their phone.
export async function prefillFor(leadId: string, formId: string, schema: IntakeSchema): Promise<Answers> {
  const last = await prisma.intakeResponse.findFirst({ where: { leadId, formId }, orderBy: { submittedAt: "desc" }, select: { answers: true } });
  if (!last) return {};
  const prev = last.answers as Answers;
  const out: Answers = {};
  for (const s of schema.sections) {
    for (const f of s.fields) {
      if (f.type === "consent" || f.type === "photos" || f.type === "info") continue;
      if (prev[f.key] !== undefined) out[f.key] = prev[f.key];
    }
  }
  return out;
}

export type IntakePhotoUpload = { field: string; slot: string; mime: string; bytes: Buffer };

export async function submitIntake(input: {
  token: string;
  verifiedPhone: string; // from the OTP token — never the form
  answers: Answers;
  photos: IntakePhotoUpload[];
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ ok: true; redFlags: number } | { ok: false; errors: string[] }> {
  const ctx = await intakeContext(input.token);
  if ("error" in ctx) return { ok: false, errors: [ctx.error] };
  if (phoneKey(input.verifiedPhone) !== phoneKey(ctx.phone)) return { ok: false, errors: ["Please verify the mobile number we have on file for this appointment."] };
  if (ctx.submitted) return { ok: false, errors: ["This form has already been completed — thank you."] };

  if (input.photos.length > MAX_PHOTOS) return { ok: false, errors: [`Up to ${MAX_PHOTOS} photos, please.`] };
  for (const p of input.photos) {
    if (!/^image\/(jpeg|png|webp)$/.test(p.mime)) return { ok: false, errors: ["Photos must be JPEG, PNG or WebP."] };
    if (p.bytes.length > MAX_PHOTO_BYTES) return { ok: false, errors: ["One of the photos is too large."] };
  }
  // Keep only answers to fields that exist (and are visible) in THIS version.
  const clean: Answers = {};
  for (const s of ctx.schema.sections) for (const f of s.fields) if (isVisible(f, input.answers) && input.answers[f.key] !== undefined) clean[f.key] = input.answers[f.key];
  const photoCounts: Record<string, number> = {};
  for (const p of input.photos) photoCounts[p.field] = (photoCounts[p.field] ?? 0) + 1;
  const errors = validateAnswers(ctx.schema, clean, photoCounts);
  if (errors.length) return { ok: false, errors };

  const redFlags = redFlagsOf(ctx.schema, clean);
  const consentFields = ctx.schema.sections.flatMap((s) => s.fields).filter((f) => f.type === "consent" && f.consentPurpose && isVisible(f, clean));

  const response = await prisma.$transaction(async (tx) => {
    const r = await tx.intakeResponse.create({
      data: {
        leadId: ctx.leadId,
        appointmentId: ctx.appointmentId,
        formId: ctx.formId,
        versionId: ctx.versionId,
        answers: clean as object,
        redFlags,
        verifiedPhone: input.verifiedPhone,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
    });
    if (input.photos.length) {
      await tx.intakePhoto.createMany({
        data: input.photos.map((p) => ({ responseId: r.id, slot: p.slot, mime: p.mime, size: p.bytes.length, bytes: new Uint8Array(p.bytes) })),
      });
    }
    // One consent row per purpose — never bundled (2.7, DPDP).
    if (consentFields.length) {
      await tx.consentRecord.createMany({
        data: consentFields.map((f) => ({
          leadId: ctx.leadId,
          purpose: f.consentPurpose!,
          granted: clean[f.key] === true || clean[f.key] === "true",
          text: f.label,
          version: `${ctx.formId}:${ctx.versionId}`,
          source: "intake_form",
          ip: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 300) ?? null,
        })),
      });
    }
    return r;
  });

  await writeAudit({
    action: "intake.submit",
    entityType: "lead",
    entityId: ctx.leadId,
    newValue: `${ctx.formName}${redFlags.length ? ` — ${redFlags.length} red flag(s)` : ""}`,
    meta: { responseId: response.id, appointmentId: ctx.appointmentId, redFlags, photos: input.photos.length },
  });
  if (redFlags.length) await alertRedFlags(ctx.appointmentId, response.id, redFlags.length).catch((err) => logger.error(`Red-flag alert failed: ${String(err)}`));
  return { ok: true, redFlags: redFlags.length };
}

/// A red-flag answer (blood thinners, bleeding disorder…) alerts the appointment's
/// doctor (if their login is linked) and the branch manager (2.7.b).
async function alertRedFlags(appointmentId: string, responseId: string, n: number) {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      lead: { select: { name: true } },
      branch: { select: { managerId: true } },
      resources: { include: { resource: { select: { kind: true, userId: true } } } },
    },
  });
  if (!a) return;
  const to = new Set<string>();
  for (const r of a.resources) if (r.resource.kind === "doctor" && r.resource.userId) to.add(r.resource.userId);
  if (a.branch.managerId) to.add(a.branch.managerId);
  for (const userId of to) {
    await notifyUser({
      userId,
      kind: "intake_red_flag",
      title: `Intake red flag: ${a.lead.name}`,
      body: `${n} answer(s) need a look before the appointment`,
      href: `/appointments/intake/${responseId}`,
      dedupeKey: `intake-flag:${responseId}:${userId}`,
    });
  }
}

/// Intake status per appointment, for the calendar, board and card.
export async function intakeStatus(appointmentIds: string[]): Promise<Map<string, { state: "none" | "pending" | "complete"; redFlags: number; responseId: string | null }>> {
  const out = new Map<string, { state: "none" | "pending" | "complete"; redFlags: number; responseId: string | null }>();
  if (!appointmentIds.length) return out;
  const [appts, responses] = await Promise.all([
    prisma.appointment.findMany({ where: { id: { in: appointmentIds } }, select: { id: true, type: { select: { intakeFormId: true } } } }),
    prisma.intakeResponse.findMany({ where: { appointmentId: { in: appointmentIds } }, select: { id: true, appointmentId: true, redFlags: true } }),
  ]);
  for (const a of appts) {
    const r = responses.find((x) => x.appointmentId === a.id);
    out.set(a.id, r ? { state: "complete", redFlags: r.redFlags.length, responseId: r.id } : { state: a.type.intakeFormId ? "pending" : "none", redFlags: 0, responseId: null });
  }
  return out;
}

/// A clinician confirms (or un-confirms) one patient-reported answer (2.7 example: the
/// doctor confirms the thyroid history → "verified").
export async function setFieldVerified(responseId: string, field: string, verified: boolean, actor: { id?: string | null; email?: string | null }) {
  const r = await prisma.intakeResponse.findUnique({ where: { id: responseId }, select: { verifiedFields: true, leadId: true } });
  if (!r) return { ok: false, error: "Not found" };
  const next = verified ? [...new Set([...r.verifiedFields, field])] : r.verifiedFields.filter((f) => f !== field);
  await prisma.intakeResponse.update({ where: { id: responseId }, data: { verifiedFields: next, reviewedById: actor.id ?? null, reviewedAt: new Date() } });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: verified ? "intake.verify" : "intake.unverify", entityType: "lead", entityId: r.leadId, field, meta: { responseId } });
  return { ok: true };
}
