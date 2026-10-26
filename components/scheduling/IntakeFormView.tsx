"use client";

// The patient's intake form (§2.7). Step 1: a code to the mobile on file (proves it's
// them — the form holds health data — and is their acceptance of the consents, 2.7.f).
// Step 2: the form — conditional questions, guided photos (resized in the browser
// before upload), separate consent ticks. A returning patient sees last time's answers
// to confirm or update.
import { useMemo, useState, useTransition } from "react";
import { sendIntakeCode, verifyIntakeCode } from "@/app/(public)/f/[token]/actions";
import { isVisible, PHOTO_SLOT_LABELS, type Answers, type IntakeField, type IntakeSchema } from "@/lib/scheduling/intake/schema";

const TZ = "Asia/Kolkata";
const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });

/// Shrink a photo to at most 1600 px on the long side, as JPEG — keeps uploads small
/// on mobile data and well under the server limit.
async function shrink(file: File): Promise<Blob> {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.82));
}

export function IntakeFormView({
  token,
  formName,
  phoneTail,
  startAt,
  service,
  branch,
}: {
  token: string;
  formName: string;
  phoneTail: string;
  startAt: string;
  service: string;
  branch: string;
}) {
  const [pending, startTransition] = useTransition();
  const [stage, setStage] = useState<"code" | "form" | "done">("code");
  const [sent, setSent] = useState<{ devCode?: string } | null>(null);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState("");
  const [schema, setSchema] = useState<IntakeSchema | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [photos, setPhotos] = useState<Record<string, { blob: Blob; url: string }>>({});
  const [errors, setErrors] = useState<string[]>([]);

  const set = (k: string, v: Answers[string]) => setAnswers((a) => ({ ...a, [k]: v }));

  function send() {
    setErrors([]);
    startTransition(async () => {
      const r = await sendIntakeCode(token);
      if (r.ok) setSent({ devCode: r.devCode });
      else setErrors([r.error ?? "Couldn't send the code"]);
    });
  }

  function verify() {
    setErrors([]);
    startTransition(async () => {
      const r = await verifyIntakeCode(token, code);
      if (!r.ok) return setErrors([r.error]);
      setVerified(r.verifiedToken);
      setSchema(r.schema);
      setAnswers(r.prefill);
      setStage("form");
    });
  }

  async function addPhoto(field: string, slot: string, file: File | undefined) {
    if (!file) return;
    const blob = await shrink(file);
    setPhotos((p) => ({ ...p, [`${field}:${slot}`]: { blob, url: URL.createObjectURL(blob) } }));
  }

  function submit() {
    setErrors([]);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("token", token);
      fd.set("verified", verified);
      fd.set("answers", JSON.stringify(answers));
      for (const [k, p] of Object.entries(photos)) fd.append(`photo:${k}`, p.blob, `${k}.jpg`);
      const res = await fetch("/api/intake-form/submit", { method: "POST", body: fd });
      const r = (await res.json().catch(() => ({ ok: false, errors: ["Something went wrong — please try again."] }))) as { ok: boolean; errors?: string[] };
      if (r.ok) setStage("done");
      else {
        setErrors(r.errors ?? ["Something went wrong"]);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  const visibleSections = useMemo(
    () => (schema?.sections ?? []).map((s) => ({ ...s, fields: s.fields.filter((f) => isVisible(f, answers)) })).filter((s) => s.fields.length),
    [schema, answers],
  );

  if (stage === "done") {
    return <div className="cara-card space-y-2 p-5 text-[15px]"><div className="text-[17px] font-semibold">Thank you</div>Your form is with the clinic. Your doctor will go through it with you at your appointment.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="cara-card space-y-1 p-5">
        <div className="text-[17px] font-semibold text-cara-ink">{formName}</div>
        <div className="text-[13.5px] text-cara-muted">For your {service} on {fmt.format(new Date(startAt))}, {branch}.</div>
        <div className="text-[12.5px] text-cara-faint">It takes about 5 minutes and saves time at your visit.</div>
      </div>

      {errors.length > 0 && (
        <div className="cara-notice is-bad">
          <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {stage === "code" && (
        <div className="cara-card space-y-3 p-5">
          <p className="text-[14px]">To keep your health information private, we&rsquo;ll send a code to your mobile ending <b>{phoneTail}</b>.</p>
          {!sent ? (
            <button className="cara-btn cara-btn-primary w-full" disabled={pending} onClick={send}>Send code</button>
          ) : (
            <div className="flex gap-2">
              <input className="cara-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <button className="cara-btn cara-btn-primary shrink-0" disabled={pending || code.length !== 6} onClick={verify}>Continue</button>
            </div>
          )}
          {sent?.devCode && <p className="text-[12px] txt-warn">Development only — your code is {sent.devCode}.</p>}
        </div>
      )}

      {stage === "form" && (
        <>
          {visibleSections.map((s) => (
            <section key={s.id} className="cara-card space-y-4 p-5">
              <div className="text-[15px] font-semibold text-cara-ink">{s.title}</div>
              {s.fields.map((f) => (
                <Field key={f.key} f={f} value={answers[f.key]} set={(v) => set(f.key, v)} photos={photos} addPhoto={addPhoto} />
              ))}
            </section>
          ))}
          <button className="cara-btn cara-btn-primary w-full" disabled={pending} onClick={submit}>
            {pending ? "Sending…" : "Submit my form"}
          </button>
        </>
      )}
    </div>
  );
}

function Field({
  f,
  value,
  set,
  photos,
  addPhoto,
}: {
  f: IntakeField;
  value: Answers[string];
  set: (v: Answers[string]) => void;
  photos: Record<string, { blob: Blob; url: string }>;
  addPhoto: (field: string, slot: string, file: File | undefined) => void;
}) {
  const label = (
    <div className="text-[14px] font-medium text-cara-ink">
      {f.label}
      {f.required && f.type !== "consent" && <span className="txt-bad"> *</span>}
    </div>
  );
  const help = f.help ? <div className="text-[12px] text-cara-muted">{f.help}</div> : null;
  if (f.type === "info") return <p className="text-[13.5px] text-cara-muted">{f.label}</p>;
  if (f.type === "consent")
    return (
      <label className="flex items-start gap-2 text-[13.5px]">
        <input type="checkbox" className="mt-1" checked={value === true} onChange={(e) => set(e.target.checked)} />
        <span>
          {f.label}
          {f.required && <span className="txt-bad"> *</span>}
          {help}
        </span>
      </label>
    );
  if (f.type === "yesno")
    return (
      <div className="space-y-1.5">
        {label}
        <div className="flex gap-2">
          {["yes", "no"].map((v) => (
            <button key={v} type="button" className={`cara-chip ${value === v ? "on" : ""}`} onClick={() => set(v)}>{v === "yes" ? "Yes" : "No"}</button>
          ))}
        </div>
        {help}
      </div>
    );
  if (f.type === "select")
    return (
      <div className="space-y-1.5">
        {label}
        <select className="cara-select" value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">Choose…</option>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {help}
      </div>
    );
  if (f.type === "multiselect") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <div className="space-y-1.5">
        {label}
        <div className="flex flex-wrap gap-2">
          {f.options?.map((o) => (
            <button key={o.value} type="button" className={`cara-chip ${chosen.includes(o.value) ? "on" : ""}`} onClick={() => set(chosen.includes(o.value) ? chosen.filter((x) => x !== o.value) : [...chosen, o.value])}>
              {o.label}
            </button>
          ))}
        </div>
        {help}
      </div>
    );
  }
  if (f.type === "photos")
    return (
      <div className="space-y-2">
        {label}
        {help}
        <div className="grid grid-cols-2 gap-2">
          {(f.photoSlots?.length ? f.photoSlots : ["photo"]).map((slot) => {
            const p = photos[`${f.key}:${slot}`];
            return (
              <label key={slot} className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-cara-rule p-2 text-center text-[12px] text-cara-muted">
                {/* A local blob preview — next/image can't optimise an object URL. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p ? <img src={p.url} alt={slot} className="h-24 w-full rounded object-cover" /> : <span className="py-6">+ {PHOTO_SLOT_LABELS[slot] ?? slot}</span>}
                {p && <span>{PHOTO_SLOT_LABELS[slot] ?? slot} — tap to replace</span>}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => addPhoto(f.key, slot, e.target.files?.[0])} />
              </label>
            );
          })}
        </div>
      </div>
    );
  return (
    <div className="space-y-1.5">
      {label}
      {f.type === "textarea" ? (
        <textarea className="cara-textarea" rows={3} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
      ) : (
        <input className="cara-input" type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={String(value ?? "")} onChange={(e) => set(e.target.value)} />
      )}
      {help}
    </div>
  );
}
