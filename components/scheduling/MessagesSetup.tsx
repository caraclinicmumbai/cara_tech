"use client";

// Messages & reminders (§2.4) — the Scheduling setup tab. The message texts (with a
// live preview filled with sample details), and per appointment type: when reminders go,
// on which channels, and how close to the appointment the patient can still change it
// themselves.
import { useState } from "react";
import {
  applyReminderPreset,
  saveMessageTemplate,
  saveReminderSettings,
  setSchedulingNumber,
  type MessageTemplateInput,
  type ReminderRuleInput,
} from "@/app/(dashboard)/appointments/setup/actions";
import { fillTemplate, REMINDER_PRESETS, SAMPLE_VARIABLES, TEMPLATE_VARIABLES } from "@/lib/scheduling/messageText";
import { Msg, useRun } from "./useRun";

export type TemplateView = MessageTemplateInput & { id: string; key: string; whatsappParams: string };
export type TypeReminders = { id: string; name: string; cutoffHours: number; rules: ReminderRuleInput[] };

const CHANNELS = ["whatsapp", "sms", "email"] as const;
const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "Email" };

function Status({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px]">
      <span className={`tag ${ok ? "tag-aqua" : "tag-neutral"}`}>{ok ? "ready" : "not set up"}</span>
      <span>
        <span className="font-medium">{label}</span> <span className="text-cara-muted">— {hint}</span>
      </span>
    </div>
  );
}

function TemplateEditor({ t, onDone }: { t: TemplateView | null; onDone?: () => void }) {
  const [f, setF] = useState<MessageTemplateInput & { whatsappParams: string }>(
    t ?? { name: "", body: "", whatsappTemplateName: "", whatsappLanguage: "en", whatsappParams: "", smsDltTemplateId: "", emailSubject: "" },
  );
  const { run, pending, msg } = useRun();
  const insert = (v: string) => setF({ ...f, body: `${f.body}{${v}}` });
  return (
    <div className="space-y-3">
      <input className="cara-input" placeholder="Name (e.g. Reminder — day before)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <textarea className="cara-textarea" rows={7} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} aria-label="Message" />
          <div className="flex flex-wrap gap-1">
            {TEMPLATE_VARIABLES.map((v) => (
              <button key={v} type="button" className="cara-chip text-[11px]" onClick={() => insert(v)}>{`{${v}}`}</button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-cara-muted">Preview (sample patient)</div>
          <div className="whitespace-pre-line rounded-lg bg-[#dcf8c6] p-3 text-[13px] text-[#14161d]">{fillTemplate(f.body, SAMPLE_VARIABLES) || "…"}</div>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="space-y-1 text-[12px] text-cara-muted">
          WhatsApp approved template name <span className="text-cara-faint">(needed outside the 24 h window)</span>
          <input className="cara-input" placeholder="e.g. appt_reminder_24h" value={f.whatsappTemplateName ?? ""} onChange={(e) => setF({ ...f, whatsappTemplateName: e.target.value })} />
        </label>
        <label className="space-y-1 text-[12px] text-cara-muted">
          Its variables, in {"{{1}}, {{2}}…"} order
          <input className="cara-input" placeholder="patient_name, date, time, branch" value={f.whatsappParams} onChange={(e) => setF({ ...f, whatsappParams: e.target.value })} />
        </label>
        <label className="space-y-1 text-[12px] text-cara-muted">
          SMS DLT template id <span className="text-cara-faint">(from the DLT portal; the text must match it exactly)</span>
          <input className="cara-input" value={f.smsDltTemplateId ?? ""} onChange={(e) => setF({ ...f, smsDltTemplateId: e.target.value })} />
        </label>
        <label className="space-y-1 text-[12px] text-cara-muted">
          Email subject
          <input className="cara-input" placeholder="Your appointment at {branch}" value={f.emailSubject ?? ""} onChange={(e) => setF({ ...f, emailSubject: e.target.value })} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => saveMessageTemplate(t?.id ?? null, f), onDone)}>
          Save message
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

function TemplateCard({ t }: { t: TemplateView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cara-card space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-cara-ink">{t.name}</span>
          {t.whatsappTemplateName ? <span className="tag tag-aqua">WA template set</span> : <span className="tag tag-neutral">no WA template</span>}
          {t.smsDltTemplateId ? <span className="tag tag-aqua">DLT id set</span> : null}
        </div>
        <button className="cara-btn" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit"}</button>
      </div>
      {!open && <div className="line-clamp-2 whitespace-pre-line text-[12.5px] text-cara-muted">{t.body}</div>}
      {open && <TemplateEditor t={t} onDone={() => setOpen(false)} />}
    </div>
  );
}

function TypeRemindersCard({ t, templates }: { t: TypeReminders; templates: TemplateView[] }) {
  const [rules, setRules] = useState<ReminderRuleInput[]>(t.rules);
  const [cutoff, setCutoff] = useState(String(t.cutoffHours));
  const { run, pending, msg } = useRun();
  const set = (i: number, p: Partial<ReminderRuleInput>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="cara-card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-cara-ink">{t.name}</span>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(REMINDER_PRESETS).map(([k, p]) => (
            <button key={k} className="cara-chip text-[11.5px]" title={p.label} disabled={pending} onClick={() => run(() => applyReminderPreset(t.id, k))}>
              Use {k} preset
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-cara-muted">
        Patient can reschedule / cancel online until
        <input type="number" min={0} className="cara-input w-20!" value={cutoff} onChange={(e) => setCutoff(e.target.value)} aria-label="Cut-off hours" />
        hours before — after that it&rsquo;s &ldquo;please call&rdquo;
      </label>
      {rules.length === 0 && <p className="cara-note text-[12px] txt-warn">No reminders for this type — patients get nothing. Pick a preset or add one.</p>}
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--cara-surface-2)] p-2 text-[12.5px]">
          <select className="cara-select w-auto!" value={r.kind} onChange={(e) => set(i, { kind: e.target.value })} aria-label="When">
            <option value="on_booking">When booked</option>
            <option value="before">Hours before</option>
            <option value="morning_of">Morning of, at</option>
          </select>
          {r.kind === "before" && (
            <input type="number" min={1} className="cara-input w-20!" value={r.hoursBefore ?? ""} onChange={(e) => set(i, { hoursBefore: Number(e.target.value) })} aria-label="Hours before" />
          )}
          {r.kind === "morning_of" && (
            <input type="time" className="cara-input w-[7.75rem]!" value={r.at ?? "06:30"} onChange={(e) => set(i, { at: e.target.value })} aria-label="Time" />
          )}
          <select className="cara-select w-auto! max-w-[16rem]!" value={r.templateId} onChange={(e) => set(i, { templateId: e.target.value })} aria-label="Message">
            <option value="">Message…</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
          {CHANNELS.map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={r.channels.includes(c)}
                onChange={(e) => set(i, { channels: e.target.checked ? [...r.channels, c] : r.channels.filter((x) => x !== c) })}
              />
              {CHANNEL_LABEL[c]}
            </label>
          ))}
          <label className="flex items-center gap-1" title="If WhatsApp can't deliver, send it by SMS">
            <input type="checkbox" checked={r.smsFallback} onChange={(e) => set(i, { smsFallback: e.target.checked })} />
            SMS fallback
          </label>
          <label className="flex items-center gap-1" title="May go out during quiet hours">
            <input type="checkbox" checked={r.quietExempt} onChange={(e) => set(i, { quietExempt: e.target.checked })} />
            quiet-hours exempt
          </label>
          <button className="cara-btn ml-auto" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="cara-btn"
          onClick={() => setRules([...rules, { kind: "before", hoursBefore: 24, at: null, templateId: templates[0]?.id ?? "", channels: ["whatsapp"], smsFallback: true, quietExempt: false }])}
        >
          + Add reminder
        </button>
        <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => run(() => saveReminderSettings(t.id, Number(cutoff), rules))}>
          Save
        </button>
        <Msg msg={msg} />
      </div>
    </div>
  );
}

export function MessagesSetup({
  templates,
  types,
  providers,
  quiet,
}: {
  templates: TemplateView[];
  types: TypeReminders[];
  providers: { whatsapp: boolean; sms: boolean; email: boolean };
  quiet: { start: number; end: number };
}) {
  const [adding, setAdding] = useState(false);
  const [qs, setQs] = useState({ start: String(quiet.start), end: String(quiet.end) });
  const { run, pending, msg } = useRun();
  return (
    <div className="space-y-6">
      <section className="cara-card space-y-2 p-5">
        <div className="font-medium text-cara-ink">Channels</div>
        <Status ok={providers.whatsapp} label="WhatsApp" hint="first choice; outside the 24 h window only approved templates are delivered" />
        <Status ok={providers.sms} label="SMS (Plivo + DLT)" hint="fallback; needs PLIVO_SMS_SENDER + PLIVO_DLT_ENTITY_ID and a DLT id per message" />
        <Status ok={providers.email} label="Email (AWS SES)" hint="surgery instructions; needs SES_REGION + SES_FROM_EMAIL" />
        <div className="flex flex-wrap items-center gap-2 pt-2 text-[12.5px] text-cara-muted">
          Quiet hours: no reminders from
          <input type="number" min={0} max={23} className="cara-input w-16!" value={qs.start} onChange={(e) => setQs({ ...qs, start: e.target.value })} aria-label="Quiet from" />
          :00 to
          <input type="number" min={0} max={23} className="cara-input w-16!" value={qs.end} onChange={(e) => setQs({ ...qs, end: e.target.value })} aria-label="Quiet to" />
          :00 IST
          <button
            className="cara-btn"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const a = await setSchedulingNumber("scheduling.quietStartHour", Number(qs.start));
                if (!a.ok) return a;
                return setSchedulingNumber("scheduling.quietEndHour", Number(qs.end));
              })
            }
          >
            Save
          </button>
          <Msg msg={msg} />
        </div>
        <p className="cara-note text-[12px]">Sending itself is switched on and off under Switches → &ldquo;Send appointment reminders&rdquo;.</p>
      </section>

      <section className="space-y-3">
        <h2 className="cara-eyebrow">When reminders go, per appointment type</h2>
        {types.length === 0 && <p className="cara-note">Add appointment types first.</p>}
        {types.map((t) => (
          <TypeRemindersCard key={t.id} t={t} templates={templates} />
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="cara-eyebrow">Messages</h2>
          {!adding && <button className="cara-btn" onClick={() => setAdding(true)}>+ New message</button>}
        </div>
        {adding && (
          <div className="cara-card p-4">
            <TemplateEditor t={null} onDone={() => setAdding(false)} />
          </div>
        )}
        {templates.map((t) => (
          <TemplateCard key={t.id} t={t} />
        ))}
      </section>
    </div>
  );
}
