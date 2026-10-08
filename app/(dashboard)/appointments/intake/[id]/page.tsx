import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { formatIst } from "@/lib/datetime";
import { writeAudit } from "@/lib/audit";
import { isVisible, PHOTO_SLOT_LABELS, type Answers, type IntakeSchema } from "@/lib/scheduling/intake/schema";
import { VerifyToggle } from "@/components/scheduling/VerifyToggle";

export const dynamic = "force-dynamic";

// A patient's intake answers (§2.7) — health data, `appointments.viewIntake`. Red flags
// first, then every answer marked patient-reported or verified, the photos, and what
// they consented to. Opening it is itself audited (a record view).
export default async function IntakeResponsePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireCapability("appointments.viewIntake");
  const { id } = await params;
  const r = await prisma.intakeResponse.findUnique({
    where: { id },
    include: {
      lead: { select: { name: true, phone: true } },
      form: { select: { name: true } },
      version: { select: { version: true, schema: true } },
      appointment: { select: { startAt: true, type: { select: { name: true } }, branch: { select: { name: true } } } },
      photos: { select: { id: true, slot: true } },
    },
  });
  if (!r) notFound();
  await writeAudit({ actorId: user.id, actorEmail: user.email, action: "record.view", entityType: "lead", entityId: r.leadId, newValue: "intake form", meta: { responseId: r.id } });
  const consents = await prisma.consentRecord.findMany({
    where: { leadId: r.leadId, source: "intake_form", createdAt: { gte: new Date(r.submittedAt.getTime() - 60_000), lte: new Date(r.submittedAt.getTime() + 60_000) } },
    orderBy: { createdAt: "asc" },
  });
  const schema = r.version.schema as unknown as IntakeSchema;
  const answers = r.answers as Answers;
  const canVerify = can(user.role, "appointments.verifyIntake");
  const fieldLabel = new Map(schema.sections.flatMap((s) => s.fields).map((f) => [f.key, f.label]));
  const show = (v: Answers[string], opts?: { value: string; label: string }[]) => {
    if (v === undefined || v === "") return "—";
    if (v === true) return "Yes";
    if (v === false) return "No";
    if (v === "yes") return "Yes";
    if (v === "no") return "No";
    const list = Array.isArray(v) ? v : [String(v)];
    return list.map((x) => opts?.find((o) => o.value === x)?.label ?? x).join(", ");
  };

  return (
    <div className="max-w-3xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="cara-eyebrow">Intake form</div>
          <h1 className="cara-title">{r.lead.name}</h1>
          <p className="cara-note">
            {r.form.name} (v{r.version.version}) · submitted {formatIst(r.submittedAt)}
            {r.appointment ? ` · for ${r.appointment.type.name}, ${formatIst(r.appointment.startAt)}, ${r.appointment.branch.name}` : ""}
          </p>
        </div>
        <Link href="/appointments" className="text-[12.5px] tone-link">Back to calendar</Link>
      </header>

      {r.redFlags.length > 0 && (
        <div className="cara-notice is-bad space-y-1">
          <div className="font-medium">Red flags — review before the appointment</div>
          <ul className="list-disc pl-5">
            {r.redFlags.map((k) => (
              <li key={k}>{fieldLabel.get(k) ?? k}: {show(answers[k])}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="cara-note text-[12px]">
        Answers are <b>patient-reported</b> until a clinician confirms them.{canVerify ? " Tick an answer once you've confirmed it in the consultation." : ""}
      </p>

      {schema.sections.map((s) => {
        const fields = s.fields.filter((f) => f.type !== "info" && f.type !== "consent" && f.type !== "photos" && isVisible(f, answers));
        if (!fields.length) return null;
        return (
          <section key={s.id} className="cara-card divide-y divide-[var(--cara-rule)]">
            <div className="px-4 py-2.5 text-[13px] font-semibold text-cara-ink">{s.title}</div>
            {fields.map((f) => {
              const verified = r.verifiedFields.includes(f.key);
              return (
                <div key={f.key} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[12px] text-cara-muted">{f.label}</div>
                    <div className={`text-[14px] ${r.redFlags.includes(f.key) ? "font-semibold txt-bad" : "text-cara-ink"}`}>{show(answers[f.key], f.options)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`tag ${verified ? "tag-aqua" : "tag-neutral"}`}>{verified ? "verified" : "patient-reported"}</span>
                    {canVerify && <VerifyToggle responseId={r.id} field={f.key} verified={verified} />}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}

      {r.photos.length > 0 && (
        <section className="cara-card space-y-2 p-4">
          <div className="text-[13px] font-semibold text-cara-ink">Photos ({r.photos.length})</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {r.photos.map((p) => (
              <a key={p.id} href={`/api/intake-form/photo/${p.id}`} target="_blank" rel="noreferrer" className="space-y-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- served by a session-gated route, never optimised/cached */}
                <img src={`/api/intake-form/photo/${p.id}`} alt={p.slot} className="h-32 w-full rounded object-cover" />
                <div className="text-[11.5px] text-cara-muted">{PHOTO_SLOT_LABELS[p.slot] ?? p.slot}</div>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="cara-card space-y-1.5 p-4">
        <div className="text-[13px] font-semibold text-cara-ink">Consents given with this form</div>
        {consents.length === 0 && <p className="cara-note text-[12px]">None recorded.</p>}
        {consents.map((c) => (
          <div key={c.id} className="flex items-start gap-2 text-[12.5px]">
            <span className={`tag ${c.granted ? "tag-aqua" : "tag-fushia"}`}>{c.granted ? "yes" : "no"}</span>
            <span>{c.text}</span>
          </div>
        ))}
        <p className="pt-1 text-[11.5px] text-cara-faint">Accepted with a code sent to {r.verifiedPhone ?? r.lead.phone}.</p>
      </section>
    </div>
  );
}
