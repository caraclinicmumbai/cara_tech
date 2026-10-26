"use client";

// The online booking widget (§2.3). Patient picks service → branch → doctor (or any) →
// day → time; the slot is held (countdown); they give name, mobile, email, tick the
// consents (appointment messages — required; marketing — separate and optional, both
// unticked by default), verify the mobile by OTP, optionally pay online at a discount,
// and get a confirmation with their manage-appointment link.
//
// Existing-patient services (follow-ups, PRP) verify the mobile FIRST, then show only
// their own surgeon's times (2.3.c — doctor hidden for follow-ups).
import { useEffect, useRef, useState, useTransition } from "react";
import {
  completeAction,
  existingPatientAction,
  holdAction,
  paymentAction,
  sendCodeAction,
  slotsAction,
  verifyCodeAction,
} from "@/app/(public)/book/actions";
import type { OnlineSlot, OnlineType } from "@/lib/scheduling/online";

type Opt = { id: string; name: string };
const TZ = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const longFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

type RazorpayHandlerResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void };
  }
}

function Step({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: string | null }) {
  return (
    <section className="cara-card space-y-3 p-4">
      <div className="flex items-baseline gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--cara-ink)] text-[12px] font-semibold text-white">{n}</span>
        <span className="font-medium text-cara-ink">{title}</span>
        {done && <span className="ml-auto truncate text-[13px] text-cara-muted">{done}</span>}
      </div>
      {children}
    </section>
  );
}

export function BookingWidget({
  branches,
  types,
  doctors,
  dates,
  holdMinutes,
  initial,
  utm,
  embedded,
  messagesOn,
}: {
  branches: Opt[];
  types: OnlineType[];
  doctors: Opt[];
  dates: string[];
  holdMinutes: number;
  initial: { branchId: string; typeId: string };
  utm: { source?: string; medium?: string; campaign?: string; content?: string };
  embedded: boolean;
  /// Reminder sending is switched on — only then do we promise a WhatsApp.
  messagesOn: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [typeId, setTypeId] = useState(types.some((t) => t.id === initial.typeId) ? initial.typeId : "");
  const [branchId, setBranchId] = useState(branches.some((b) => b.id === initial.branchId) ? initial.branchId : branches.length === 1 ? branches[0].id : "");
  const [doctorId, setDoctorId] = useState<string>("any");
  const [dateKey, setDateKey] = useState(dates[0]);
  const [dayCount, setDayCount] = useState(14);
  const [slots, setSlots] = useState<{ key: string; list: OnlineSlot[] } | null>(null);
  const [hold, setHold] = useState<{ token: string; expiresAt: string; slot: OnlineSlot } | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", consentMessages: false, consentMarketing: false, website: "" });
  const [otp, setOtp] = useState<{ sent: boolean; code: string; devCode?: string; verified: string | null }>({ sent: false, code: "", verified: null });
  const [existingDoctor, setExistingDoctor] = useState<{ checked: boolean; doctorId: string | null }>({ checked: false, doctorId: null });
  const [payOnline, setPayOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refresh, setRefresh] = useState(0); // bump to re-fetch the day's slots
  const root = useRef<HTMLDivElement>(null);

  const type = types.find((t) => t.id === typeId);
  const existingOnly = type?.audience === "existing";
  const effectiveDoctor = !type?.needsDoctor ? "none" : existingOnly ? (existingDoctor.doctorId ?? "any") : doctorId;
  const slotKey = `${typeId}|${branchId}|${effectiveDoctor}|${dateKey}|${refresh}`;
  const ready = !!typeId && !!branchId && (!existingOnly || existingDoctor.checked);

  // Embedded: tell the parent page our height.
  useEffect(() => {
    if (!embedded || !root.current) return;
    const ro = new ResizeObserver(() => window.parent?.postMessage({ type: "cara-booking-height", height: document.documentElement.scrollHeight + 8 }, "*"));
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [embedded]);

  // Countdown tick while a slot is held.
  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold]);

  // Load slots for the chosen day.
  useEffect(() => {
    if (!ready || done) return;
    let live = true;
    slotsAction({ typeId, branchId, doctorId: effectiveDoctor, dateKey }).then((list) => live && setSlots({ key: slotKey, list }));
    return () => {
      live = false;
    };
  }, [ready, typeId, branchId, effectiveDoctor, dateKey, slotKey, done]);
  const daySlots = slots?.key === slotKey ? slots.list : null;
  const secondsLeft = hold ? Math.max(0, Math.floor((new Date(hold.expiresAt).getTime() - now) / 1000)) : 0;

  function pick(slot: OnlineSlot) {
    setError(null);
    startTransition(async () => {
      const r = await holdAction({ typeId, branchId, doctorId: slot.doctorId, startAt: slot.startAt, previous: hold?.token ?? null, website: form.website });
      if (r.ok) setHold({ token: r.holdToken, expiresAt: r.expiresAt, slot });
      else {
        setError(r.error);
        setRefresh((n) => n + 1); // the picture changed — reload the day
      }
    });
  }

  function sendCode() {
    setError(null);
    startTransition(async () => {
      const r = await sendCodeAction(form.phone);
      if (r.ok) setOtp({ sent: true, code: "", devCode: r.devCode, verified: null });
      else setError(r.error);
    });
  }

  function verify() {
    setError(null);
    startTransition(async () => {
      const r = await verifyCodeAction(form.phone, otp.code);
      if (!r.ok) return setError(r.error);
      setOtp((o) => ({ ...o, verified: r.token }));
      if (existingOnly) {
        const e = await existingPatientAction(r.token);
        if (!e.ok) setError(e.error ?? "Not found");
        else setExistingDoctor({ checked: true, doctorId: e.doctorId ?? null });
      }
    });
  }

  function book() {
    if (!hold || !otp.verified) return;
    setError(null);
    startTransition(async () => {
      const r = await completeAction({
        holdToken: hold.token,
        verifiedToken: otp.verified!,
        name: form.name,
        email: form.email,
        consentMessages: form.consentMessages,
        consentMarketing: form.consentMarketing,
        payOnline: !!type?.prepay && payOnline,
        utm: { source: utm.source, medium: utm.medium, campaign: utm.campaign, content: utm.content },
        website: form.website,
      });
      if (!r.ok) return setError(r.error);
      if (r.done) return setDone({ link: r.link });
      // Pay with Razorpay Checkout.
      await loadRazorpay();
      if (!window.Razorpay) return setError("Payment couldn't load — please try again or pay at the clinic.");
      const rzp = new window.Razorpay({
        key: r.payment.keyId,
        order_id: r.payment.orderId,
        amount: r.payment.amountPaise,
        currency: "INR",
        name: r.payment.name,
        description: r.payment.description,
        prefill: r.payment.prefill,
        handler: (resp: RazorpayHandlerResponse) =>
          startTransition(async () => {
            const p = await paymentAction({ holdToken: hold.token, orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature });
            if (p.ok && p.done) setDone({ link: p.link });
            else if (!p.ok) setError(p.error);
          }),
        modal: { ondismiss: () => setError("Payment wasn't completed. You can try again, or untick 'pay now' to pay at the clinic.") },
      });
      rzp.open();
    });
  }

  if (done && hold) {
    return (
      <div ref={root} className="space-y-4">
        <div className="cara-card space-y-2 p-5">
          <div className="text-[18px] font-semibold text-cara-ink">You&rsquo;re booked</div>
          <div className="text-[15px]">
            {type?.name}
            <br />
            {longFmt.format(new Date(hold.slot.startAt))}, {timeFmt.format(new Date(hold.slot.startAt)).toUpperCase()}
            <br />
            {branches.find((b) => b.id === branchId)?.name}
            {hold.slot.doctorName ? ` · with ${hold.slot.doctorName}` : ""}
          </div>
          <p className="text-[13px] text-cara-muted">
            {messagesOn ? "We\u2019ve sent the details to your WhatsApp. " : "Please save this link. "}
            You can confirm, reschedule or cancel from it:
          </p>
          <a href={done.link} target={embedded ? "_top" : undefined} className="block break-all text-[13px] underline">{done.link}</a>
        </div>
      </div>
    );
  }

  const newTypes = types.filter((t) => t.audience === "anyone");
  const existingTypes = types.filter((t) => t.audience === "existing");

  return (
    <div ref={root} className="space-y-3">
      <Step n={1} title="What would you like to book?" done={type?.name}>
        <div className="grid gap-2">
          {[["New patients", newTypes], ["Already a patient?", existingTypes]].map(([label, list]) =>
            (list as OnlineType[]).length ? (
              <div key={label as string} className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-cara-muted">{label as string}</div>
                {(list as OnlineType[]).map((t) => (
                  <button
                    key={t.id}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left ${typeId === t.id ? "border-[var(--cara-ink)] bg-[var(--cara-surface-2)]" : "border-cara-rule"}`}
                    onClick={() => {
                      setTypeId(t.id);
                      setHold(null);
                      setExistingDoctor({ checked: false, doctorId: null });
                    }}
                  >
                    <div className="font-medium">{t.name}</div>
                    <div className="text-[12.5px] text-cara-muted">
                      {t.durationMin} min{t.fee ? ` · ₹${t.fee.toLocaleString("en-IN")}` : ""}
                      {t.prepay && t.prepay.discountPct > 0 ? ` · save ${t.prepay.discountPct}% when you pay online` : ""}
                    </div>
                  </button>
                ))}
              </div>
            ) : null,
          )}
          <p className="text-[12px] text-cara-muted">Surgery is planned after a consultation. Book a consultation to get started.</p>
        </div>
      </Step>

      {type && branches.length > 1 && (
        <Step n={2} title="Which clinic?" done={branches.find((b) => b.id === branchId)?.name}>
          <div className="flex flex-wrap gap-2">
            {branches.map((b) => (
              <button key={b.id} className={`cara-chip ${branchId === b.id ? "on" : ""}`} onClick={() => { setBranchId(b.id); setHold(null); }}>
                {b.name}
              </button>
            ))}
          </div>
        </Step>
      )}

      {type && branchId && existingOnly && !existingDoctor.checked && (
        <Step n={3} title="Verify your mobile number">
          <p className="text-[13px] text-cara-muted">This service is for existing patients — we&rsquo;ll book you with your own doctor.</p>
          <PhoneVerify phone={form.phone} setPhone={(phone) => setForm({ ...form, phone })} otp={otp} setOtp={setOtp} pending={pending} sendCode={sendCode} verify={verify} />
        </Step>
      )}

      {type && branchId && type.needsDoctor && !existingOnly && (
        <Step n={3} title="Doctor" done={doctorId === "any" ? "Any available doctor" : doctors.find((d) => d.id === doctorId)?.name}>
          <select className="cara-select" value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setHold(null); }} aria-label="Doctor">
            <option value="any">Any available doctor</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Step>
      )}

      {ready && (
        <Step n={4} title="Pick a time" done={hold ? `${dayFmt.format(new Date(hold.slot.startAt))}, ${timeFmt.format(new Date(hold.slot.startAt))}` : null}>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {dates.slice(0, dayCount).map((d) => (
              <button key={d} className={`cara-chip shrink-0 ${dateKey === d ? "on" : ""}`} onClick={() => setDateKey(d)}>
                {dayFmt.format(new Date(`${d}T12:00:00+05:30`))}
              </button>
            ))}
            {dayCount < dates.length && (
              <button className="cara-chip shrink-0" onClick={() => setDayCount((n) => Math.min(n + 14, dates.length))}>More dates</button>
            )}
          </div>
          {daySlots === null ? (
            <p className="text-[13px] text-cara-muted">Finding free times…</p>
          ) : daySlots.length === 0 ? (
            <p className="text-[13px] text-cara-muted">No free times this day — try another.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {daySlots.map((s) => (
                <button
                  key={s.startAt}
                  disabled={pending}
                  className={`rounded-lg border px-2 py-2 text-center text-[13px] ${hold?.slot.startAt === s.startAt ? "border-[var(--cara-ink)] bg-[var(--cara-ink)] text-white" : "border-cara-rule"}`}
                  onClick={() => pick(s)}
                >
                  {timeFmt.format(new Date(s.startAt))}
                  {doctorId === "any" && !existingOnly && s.doctorName && <div className="truncate text-[10.5px] opacity-75">{s.doctorName}</div>}
                </button>
              ))}
            </div>
          )}
          {hold && (
            <p className={`text-[12.5px] ${secondsLeft < 60 ? "txt-warn" : "text-cara-muted"}`}>
              {secondsLeft > 0
                ? `Held for you for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
                : `Your ${holdMinutes}-minute hold ran out — pick the time again.`}
            </p>
          )}
        </Step>
      )}

      {hold && secondsLeft > 0 && (
        <Step n={5} title="Your details">
          <input className="cara-input" placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
          {!existingOnly && <PhoneVerify phone={form.phone} setPhone={(phone) => setForm({ ...form, phone })} otp={otp} setOtp={setOtp} pending={pending} sendCode={sendCode} verify={verify} />}
          <input className="cara-input" placeholder="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
          {/* Honeypot: invisible to people, irresistible to bots. */}
          <input tabIndex={-1} autoComplete="off" className="hidden" aria-hidden value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} name="website" />
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={form.consentMessages} onChange={(e) => setForm({ ...form, consentMessages: e.target.checked })} />
            <span>Send me WhatsApp and SMS messages about this appointment — confirmation, reminders and changes. <span className="text-cara-muted">(needed to book)</span></span>
          </label>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={form.consentMarketing} onChange={(e) => setForm({ ...form, consentMarketing: e.target.checked })} />
            <span>Also send me offers and updates about treatments. <span className="text-cara-muted">(optional — reply STOP any time)</span></span>
          </label>
          {type?.prepay && (
            <div className="space-y-1.5 rounded-lg bg-[var(--cara-surface-2)] p-3 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="radio" checked={payOnline} onChange={() => setPayOnline(true)} />
                Pay now {rupees(type.prepay.payPaise)}
                {type.prepay.discountPct > 0 && <span className="tag tag-lime">save {type.prepay.discountPct}%</span>}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!payOnline} onChange={() => setPayOnline(false)} />
                Pay at the clinic {rupees(type.prepay.listPaise)}
              </label>
            </div>
          )}
          <button className="cara-btn cara-btn-primary w-full" disabled={pending || !otp.verified || !form.name.trim() || !form.consentMessages} onClick={book}>
            {pending ? "Please wait…" : type?.prepay && payOnline ? "Pay & book" : "Book appointment"}
          </button>
          {!otp.verified && <p className="text-[12px] text-cara-muted">Verify your mobile number to book.</p>}
        </Step>
      )}

      {error && <div className="cara-notice is-bad">{error}</div>}
    </div>
  );
}

function PhoneVerify({
  phone,
  setPhone,
  otp,
  setOtp,
  pending,
  sendCode,
  verify,
}: {
  phone: string;
  setPhone: (v: string) => void;
  otp: { sent: boolean; code: string; devCode?: string; verified: string | null };
  setOtp: (o: { sent: boolean; code: string; devCode?: string; verified: string | null }) => void;
  pending: boolean;
  sendCode: () => void;
  verify: () => void;
}) {
  if (otp.verified) return <div className="text-[13px] txt-good">Mobile {phone} verified</div>;
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          className="cara-input"
          placeholder="Mobile number"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <button className="cara-btn shrink-0" disabled={pending || phone.replace(/\D/g, "").length < 10} onClick={sendCode}>
          {otp.sent ? "Resend" : "Send code"}
        </button>
      </div>
      {otp.sent && (
        <div className="flex gap-2">
          <input
            className="cara-input"
            placeholder="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp.code}
            onChange={(e) => setOtp({ ...otp, code: e.target.value.replace(/\D/g, "") })}
          />
          <button className="cara-btn cara-btn-primary shrink-0" disabled={pending || otp.code.length !== 6} onClick={verify}>Verify</button>
        </div>
      )}
      {otp.devCode && <p className="text-[12px] txt-warn">Development only — no SMS/WhatsApp configured. Your code is {otp.devCode}.</p>}
    </div>
  );
}

let razorpayLoading: Promise<void> | null = null;
function loadRazorpay(): Promise<void> {
  if (typeof window === "undefined" || window.Razorpay) return Promise.resolve();
  razorpayLoading ??= new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.body.appendChild(s);
  });
  return razorpayLoading;
}
