# 15 — Appointments & scheduling (Module 3.2)

One real-time system to book, move, confirm and run appointments across every branch.
**Rooms and the OT team (support staff) are never double-booked.** Doctors and
equipment are tracked and warned about, but not blocked (spec §2.1, decided
2026-10-08): booking over a busy doctor or machine needs an acknowledgement, which is
recorded.

> **Built so far:**
> - Phase A: data model, conflict engine, booking service, setup screen.
> - **2.1 Multi-resource scheduling.**
> - **2.2 Branch & chain calendar:** the front-desk calendar with booking,
>   rescheduling, check-in and the board; cross-branch doctor rosters; one-off changes;
>   travel time; privacy across branches.
> - **2.9 Doctor availability & leave sync:** leave requests and approval, emergency
>   unavailability, visiting-doctor contract dates, the "needs rebooking" worklist with
>   suggestions, and escalation.
> - **2.4 Reminders & reschedule links:** per-type timelines, WhatsApp → SMS → email,
>   quiet hours, the patient's signed link (confirm / reschedule / cancel within a
>   cut-off), "1/2" replies, and a delivery log. **Sending is off** until the clinic
>   switches it on.
> - **2.3 Online booking widget** (`/book`, embeddable on caraclinics.com): online-only
>   types, any or a named doctor, slot hold, OTP, separate consents, UTM attribution,
>   existing-patient follow-ups with their own surgeon, optional Razorpay prepay for
>   consultations.
> - **2.7 Intake forms:** a form builder with versions, conditional questions, red flags,
>   the under-18 guardian section, guided photos and separate consents. Code-verified
>   patient access, field-by-field clinician verification, status on the calendar.
> - **2.8 Treatment series & recall:** series templates with calendar-month offsets
>   and windows, plans per patient (auto-started from a sold package or by hand), 30-day
>   pre-booking with the surgeon, anchor shifts, a recall ladder, a patient recall link
>   and the branch recall list.
>
> 2.5 (walk-in queue/tokens) and 2.6 (no-show tracking and waitlist) are **deferred**
> by decision; see `docs/deferred-todo.md`.

## Decisions taken (2026-10-08)

| # | Decision | Outcome |
|---|---|---|
| 1.A | Status lifecycle | Adopted as written: tentative → booked → confirmed → checked-in → in progress → completed, plus rescheduled / cancelled / no-show |
| 1.B | Front-desk board | In: Phase B |
| 1.C | Branch hours, holidays, blackouts | In: built here |
| 1.D | Support staff as a resource | In, for **every** appointment type, not only surgery |
| 1.E | Booking audit trail | In: every write goes to the hash-chained `AuditLog` |
| — | Doctor double-booking | Allowed, with a warning that has to be acknowledged (switchable) |
| 2.1 | What hard-blocks | **Rooms and the OT team only.** Doctors and equipment warn (equipment switchable: "Block equipment like rooms", default off) |
| 2.1.a | Scheduled resource types | Rooms and OT team blocked; doctors and equipment tracked |
| 2.1.b | Turnover buffers | Per appointment type: none for minor treatments, 45–60 min for hair transplant |
| 2.1.c | Conflict override | Branch manager (`appointments.override`) may override a **consultation-room** clash, with a reason recorded on the row and in the audit log. Never an OT, never the OT team |
| 2.1.d | Named vs any | Patients book a **specific surgeon and treatment**. The engine never auto-picks a doctor |
| 2.2 | Doctor at two branches | **One person, one calendar.** Overlapping, or inside the travel time, at a *different* branch = **blocked** (geography, not policy). Same-branch overlap stays a confirmable warning |
| 2.2.a | Travel time | Configurable matrix per branch pair, default **90 min** for any pair not set |
| 2.2.b | Cross-branch visibility | Free/busy only ("Booked"): no patient, service, notes or flags for other branches. Exceptions: `appointments.viewAllBranches` (call centre, head office, branch managers) and a doctor's own appointments anywhere |
| 2.2.c | Who books across branches | `appointments.bookAnyBranch`: telecaller (call centre), telecalling head, branch manager, sales head (+ admin). Front desk books at their home branch only |
| 2.2.d | Moving equipment | Not built. Decided (Fahar, 2026-10-08): no transfer log while nothing moves. `Resource.branchId` already *is* the current branch, and every edit is audited (`scheduling.resource.update`), so a move today is an audited edit. A dedicated transfer log can be added if portable machines appear |
| 2.9.a | Who owns the doctor's calendar | The doctor (or anyone linked to a resource) **requests** leave; head office (`appointments.approveLeave`: Sales Head + admin) **approves**. Managers can enter leave directly (approved) |
| 2.9.b | Existing appointments | **Never** cancelled or moved automatically. They go to the "needs rebooking" list with suggestions; staff choose, and the patient is messaged (WhatsApp; SMS + reschedule link come with 2.4) and confirmed by call |
| 2.9.c | Google/Outlook sync | Phase 2 (deferred) |
| 2.9.d | Emergency same-day | "Mark unavailable now": blocks to midnight, cases opened as **urgent**, **Admin + Sales Head** alerted in-app and on Slack; rebook via WhatsApp + calls |
| 2.9.e | Visiting doctors | Clinic admin enters contract dates on the resource (setup); the doctor can see their calendar. Outside the dates they can't be booked |
| 2.9.f | Leave notice rules | Taken up with the HR module (3.8) |
| 2.4.a | Reminder timeline | Per appointment type, editable (setup → Messages & reminders). Presets from the spec: **consultation** confirmation + 24 h + 2 h; **treatment** confirmation + 24 h; **surgery** confirmation + 7 d (WhatsApp + email checklist) + 72 h + 24 h (WhatsApp + SMS) + 06:30 morning-of |
| 2.4.b | Self-service cut-off | Per type: consultation **4 h**, treatments **24 h**, surgery **72 h**. Inside it: "please call" + a call-required case on the worklist |
| 2.4.c | WhatsApp provider | No BSP: our own Meta Cloud API account (already in use) |
| 2.4.d | SMS / DLT | Plivo SMS (decided 2026-10-08); DLT registration by Jatin (initiated). SMS stays off until sender + entity id are set |
| 2.4.e | Languages | English |
| 2.4.f | Quiet hours | 21:00–08:00 IST (editable); the morning-of-surgery reminder is exempt |
| — | Email provider | AWS SES (decided 2026-10-08), off until configured |
| 2.3.a | What's bookable online | Types marked online-bookable. Audience: **anyone** (first consultations) or **existing patients** (follow-ups, PRP). Surgery never; the widget says "Surgery is planned after a consultation" |
| 2.3.b | Online payment | **Razorpay** (decided 2026-10-08), consultations only (types open to new patients, with a fee), optional per type, with a prepay discount %. Off until keys are set |
| 2.3.c | Doctor choice | New patients: "Any available doctor" (slots merged; booking lands on the slot's named doctor) or a specific one. Existing-patient services: hidden, their own surgeon |
| 2.3.d | Lead time | Minimum notice **3 h**, up to **90 days** ahead (editable) |
| 2.3.e | Mobile app | Later, on the same service |
| 2.3.f | Languages | English |
| 2.7.a | Which forms | The clinic builds them (setup → Intake forms); question lists from the clinical lead (Jatin). A starter hair-loss form from the spec ships as a draft |
| 2.7.b | Red flags | Marked per question in the builder ("Yes" is a red flag; options prefixed `!`). The appointment's doctor and the branch manager are alerted. The list comes from the clinical lead (Jatin) |
| 2.7.c | Block booking until done | **No.** Reminders carry the link instead |
| 2.7.d | Patient photo upload | Allowed (decided 2026-10-08). Guided angles, resized in the browser, size-capped, stored in the database until 3.12's document store, served only to `appointments.viewIntake` |
| 2.7.e | Minors | A date-of-birth answer under 18 reveals required guardian details + guardian consent |
| 2.8.a | Series templates | Clinic-editable (setup → Treatment series); intervals from the clinical lead (Jatin). **1 month between treatments** by default ("+ step one month later") |
| 2.8.b | Pre-book vs due window | Steps whose target is **within 30 days** are booked at once; later steps wait in their window |
| 2.8.c | Missed / expired sessions | **Extended manually** (with a reason), or waived with a reason. Both audited |
| 2.8.d | Recall ladder | WhatsApp when the window opens → WhatsApp + SMS at day 3 → **call task** at day 7. Switch `scheduling.recallEnabled` (off until the template is approved) |
| 2.8.e | Follow-ups at another branch | Allowed: the patient's recall link offers every branch; staff can book anywhere they may book |
| 2.8.f | Who does follow-ups | **The surgeon**: steps marked "with the surgeon" book the plan's doctor |
| 2.7.f | Signature | The code to the patient's own mobile is their acceptance (OTP-based). Surgical consent stays physical/eSign (outside 3.2) |
| — | Toggles | Global, not per branch |
| — | Patient = ? | The **Lead**. Cara has no separate patient table |
| — | Zenoti history | Not imported now. Build first, import after |

## Trigger

Any booking, reschedule or status change, from any screen (front desk, call centre, the
online link, the series generator). All of them go through
[lib/scheduling/booking.ts](../../lib/scheduling/booking.ts), so the guarantee can't
depend on which screen made the request.

## Step-by-step: a booking

1. **Load the type.** The appointment type gives the duration, the turnover buffer, and
   the requirements, e.g. *1 doctor + 1 room of type `ot` + 2 staff of type
   `technician`*.
2. **Open a transaction and lock.** Take a Postgres advisory lock
   (`pg_advisory_xact_lock(hashtext('sched:'+id))`) on **every resource that could take
   part**: the branch's rooms and equipment, and every doctor and staff member who could
   work there. Locks are taken in sorted order so two bookings can't deadlock.
3. **Reload inside the lock.** Load the day (branch hours, closures, rosters, leave,
   existing bookings). A booking that was waiting on the lock now sees the rows the
   winner just committed.
4. **Run the engine.** [lib/scheduling/engine.ts](../../lib/scheduling/engine.ts) is pure
   (no database). It honours the resources the person picked, auto-fills the rest from
   free matching resources, and returns every problem as `block` or `warn`.
5. **Decide.** Any `block` refuses the booking. A `warn` with `needsAck` (an overbooked
   doctor) is refused with `needsAck: true` until the request comes back with
   `acknowledgeWarnings`.
6. **Insert.** The `Appointment` row plus one `AppointmentResource` row per resource,
   holding `startAt … endAt + buffer`. Then commit, which releases the locks.
7. **Audit.** `appointment.book`, with the resources and any acknowledged warnings.

**Proven, not assumed.** `npm run check:scheduling` fires 12 simultaneous bookings at one
room and asserts exactly one wins. With the locks switched off, the same test lets **7**
through.

## The rules the engine enforces

| Rule | Severity |
|---|---|
| Room / OT-team (staff) already booked | **block, always** (consultation room: branch-manager override with reason) |
| Equipment already booked or under maintenance | warn + acknowledge (block if "Block equipment like rooms" is on) |
| Doctor already booked | warn + acknowledge (block if "Allow doctors to be double-booked" is off) |
| Doctor not chosen | block: "Choose the doctor" |
| Doctor/OT-team member booked at **another branch** at an overlapping time | **block, always** (2.2: one person, one calendar) |
| …or at another branch with less than the travel time in between | **block, always** (2.2.a) |
| Outside branch hours, closed day, holiday, part-day closure | block (warn if "Enforce branch hours" is off) |
| Doctor/staff outside their roster at this branch | block (warn if "Enforce rosters" is off) |
| Doctor/staff on leave | block (warn if rosters aren't enforced) |
| Room downtime | block, always |
| Room/equipment from another branch | block |
| Not enough free resources for a requirement ("needs 2 technicians, only 1 free") | block |
| Start in the past (unless back-dating a walk-in) | block |
| Runs past midnight | block (a multi-day surgery is a series, not one row) |

Two subtleties:
- **Intervals are half-open.** 11:00–12:00 and 12:00–12:30 don't clash.
- **Doctors are never auto-filled** (2.1.d). Rooms, the OT team and machines are; a
  doctor is always the one the person booking named, so overbooking a doctor only
  happens when someone picked them and acknowledged it.

## Feature 2.1 behaviours

- **Find a slot** (`/appointments`, `appointments.view`): branch + treatment + the
  named doctor + day. The screen shows the start times that work. Times that only work
  over a busy doctor or machine are shown in orange with the reason on hover. If the
  day has no slot, it lists **why** (`explainDay`: the distinct blocking reasons, most
  common first, e.g. "Needs 3 × technician — only 2 free") and the **next available
  day** within 14 (`searchAvailability`).
- **"Just taken."** Every booking evaluates once *before* the locks and once inside
  them. If the first said free and the second says no, someone else booked it in
  between. The loser gets "That slot was just taken by another booking — please pick
  another time." (`justTaken: true`), not a clash list they never saw.
- **Rescheduling re-allocates.** Only the patient's named surgeon carries over. Rooms,
  the OT team and machines are allocated from scratch for the new time; the old ones
  are never assumed to still be valid.
- **Override.** A clash on a room marked "branch manager may override" (setup → Resources,
  refused for an OT) comes back `overridable: true`. Re-submitted with
  `override: { reason }`, it books, sets `Appointment.overrideReason/overriddenById`,
  and audits as `appointment.book.override`. The caller must hold
  `appointments.override`; the booking UI (Phase B) will gate the button on it.
- **Auto-fill order.** A completely free resource first. Failing that, one whose only
  problems are warnings (a busy machine), with the warning surfaced for
  acknowledgement. Never one with a block.

## Feature 2.2: the calendar

`/appointments` (`appointments.view`). One calendar, two scopes, five views. State is in
the URL (`view`, `date`, `branch`, `doctor`, `staff`, `type`), so a view can be bookmarked
or shared.

| View | What it is |
|---|---|
| **Day · columns** | Resource-as-columns for one branch (the front-desk default): doctors, OT team, rooms, machines. Not-working time is hatched; a doctor rostered elsewhere today shows **"at Santacruz 10 AM–5 PM"** in the header. Overlapping appointments sit side by side. Red line = now. Click open time to book there |
| **Day · list** | Zenoti's list: grouped by hour, guest + flags, time, consultant, service, (branch), status |
| **Week** | Seven days. Filtered to one doctor, each day header shows where they are ("Juhu 10–5", "Juhu 9–1 → Santacruz 3–6") |
| **Front desk board** | 1.B: Expected → Waiting (checked in) → With the doctor → Done → No-show, with one-tap Check in / Start / Complete; "running late" after 15 min |
| **Find a slot** | 2.1 search, plus **All branches**: the earliest slot for that doctor at every branch, soonest first. Clicking a time opens booking |

**Defaults:**
- Front desk opens on their **home branch** as columns.
- A doctor whose login is linked to a resource opens on **their own calendar across
  all branches**.
- "All branches" is the chain view.

**Privacy (2.2.b):** applied in `lib/scheduling/calendar.ts` before anything leaves the
server. A masked appointment carries only time, branch and resources. The card for it
says "Another branch's appointment" and offers no actions.

**Booking from the desk** (`BookingDrawer`):
1. Find the patient by name or phone. The search returns name + last 4 digits only, and
   ignores lead-ownership scope, because the receptionist isn't the counsellor.
2. Or add a new patient. A known phone returns the existing record, never a duplicate.
3. Choose branch (own only, unless `bookAnyBranch`), treatment, named doctor and day,
   then pick a free slot.
4. Book. Server answers are shown as they come: confirm-warnings, the override box
   (branch manager), or "just taken" (the slot list refreshes).

Booking moves the lead's stage forward to **appointment scheduled** (forward-only).

**Appointment card:**
- Shows patient, phone, flag chips (click to set/clear, audited), status, service, time,
  branch, resources and notes.
- Offers only the status moves allowed from the current status. Running the day (check
  in, start, complete, no-show) needs `checkin`; confirm/cancel/reschedule need `book`.
  Cancelling asks who cancelled (patient/clinic) and why.
- Reschedule keeps the doctor and picks a new slot.

**Rosters across branches:**
- A weekly roster can put one person at different branches on different days or
  half-days.
- Saving a roster (or a one-off change) with two branches on one day is **refused**
  unless the gap covers the travel time.
- **One-off changes** (`ResourceScheduleException`) replace the weekly roster for their
  date: a moved clinic day, a Sunday clinic, a split day.
- Setup → Resources → One-off changes; Setup → Hours → Travel time.

## Feature 2.9: doctor availability and leave sync

**One source of truth per person.** The weekly roster (2.2), one-off changes, leave and
contract dates all sit on the person's resource. The engine reads one calendar per
person, so approved leave blocks them at **every** branch, and the online widget will
never offer that time.

**Leave** (`/appointments/leave`):
- A doctor requests their own leave (type, dates, reason). Approvers get a bell entry
  showing how many booked appointments fall inside.
- **Requested** leave doesn't block. A booking inside it shows a warning that has to be
  confirmed ("has requested leave — not yet approved").
- **Approved** leave blocks. Every live appointment inside it becomes a rebooking case
  (cause `leave`).
- **Rejected** leave needs a note. **Withdrawing** approved leave re-checks its cases and
  closes those that fit again.
- **Emergency** (`markEmergency`): approved leave from now to midnight, urgent cases,
  and an alert to admins and the Sales Head (bell + Slack).

**What opens a rebooking case** (`lib/scheduling/conflicts.ts`):

| Trigger | Cause |
|---|---|
| Leave approved / entered | `leave` |
| Emergency | `emergency` |
| Roster saved, one-off change removed | `roster` |
| One-off change added | `exception` |
| Room/machine downtime, resource retired | `downtime` |
| Contract dates or branch changed on a resource | `contract` |
| Holiday / blackout added over booked dates | `closure` |

"Doesn't fit" is decided by re-running the booking engine on the appointment in place,
with the people and rooms it holds. The reason shown is the engine's own message
("Dr Asif is unavailable (conference)").

**Needs rebooking** (`/appointments/rebooking`, `appointments.book`, own branch unless
`bookAnyBranch`):
- Each case shows patient (tap to call), appointment, reason, owner (the branch
  manager), due time, and an urgent/overdue marker.
- **Show options** suggests:
  1. the same doctor's next free time at this branch, over the next three weeks;
  2. another doctor at this branch at the same time;
  3. the same doctor at another branch (earliest).
- **Move & tell patient** reschedules and messages the patient: "Dr Asif is
  unavailable on Tue 13 Oct. Your appointment has been moved to … Reply if this doesn't
  work." The case goes to `proposed` and waits there until staff mark **Patient
  confirmed**, or **Patient declined — call required**.
- Also: **Resolved by phone** and **Dismiss** (dismiss needs a note).
- **Due** is two days before the appointment (or two hours from now if it's sooner);
  under 24 h it's **urgent**. The worker escalates overdue cases every 30 minutes, once:
  owner, admins and Sales Head get a bell entry, and Slack gets a summary.

**Bell links:** notifications can now carry an `href`, so leave requests and rebooking
alerts open the right page rather than a lead.

## Feature 2.4: reminders and reschedule links

**Lifecycle** (`lib/scheduling/reminders.ts`):

| Event | Effect on reminders |
|---|---|
| Booked (or a hold turned into a booking) | Rows created from the type's rules |
| Rescheduled | Old pending rows **cancelled**, fresh rows for the new time (no second confirmation) |
| Cancelled, no-show, checked in, started, completed | Pending rows cancelled |

When a reminder is created:
- A rule whose moment already passed (a late booking) isn't created at all.
- A reminder that would land in quiet hours waits until they end, unless the rule is
  quiet-exempt.
- One that would then arrive within 15 minutes of the appointment isn't sent.

**Sending:**
- The worker tick runs every minute and claims each due row first, so it can't be sent
  twice.
- **WhatsApp:** free text inside the 24 h window. Outside it, the message's approved
  WhatsApp template with its parameters. With no template set, WhatsApp is *skipped and
  says so*.
- **SMS:** when listed, or as the fallback when WhatsApp didn't go out. Also sent if Meta
  later reports the WhatsApp message **failed** (the webhook triggers it).
- **Email:** in parallel when listed.
- Every channel's outcome is stored on the row (`sent`, `delivered`, `read`,
  `failed: …`, `skipped: …`) and shown on the **appointment card** ("Messages to
  patient"), next to **Copy patient link**.
- Reminders are transactional: they go out under **clinical consent**
  (`clinical: true`), not the marketing opt-out.
- While **"Send appointment reminders"** is off (the default), due rows are marked
  *skipped*. Switching it on never sends a backlog.

**Messages** (`AppointmentMessageTemplate`):
- English text with `{placeholders}`: patient_name, date, time, service, doctor,
  branch, branch_address, branch_phone, map_link, prep (the type's preparation
  instructions), link, clinic.
- Each message also holds its WhatsApp template name + parameter order, its SMS DLT
  template id, and an email subject. Seven defaults are seeded, worded from the spec.
- Setup shows a live preview with sample details, generated by the same filler the
  sender uses. A line whose only placeholder is empty disappears.

**The patient's link** (`/a/<token>`, public, `lib/scheduling/links.ts`):
- The token is an HMAC of the appointment id + expiry (the appointment's end) with
  `AUTH_SECRET`. Nothing is stored; tampered or expired links fail.
- The page shows the appointment, directions and preparation, with **Confirm**, and
  **Choose a different time** / **Cancel** while the patient is outside the type's
  cut-off.
- Inside the cut-off it shows "please call" plus **Ask the clinic to call me**, which
  opens an urgent call-required case.
- Every action re-verifies the token, re-reads the appointment, re-checks the cut-off,
  and is rate-limited (30/h per appointment, 60/h per IP).
- A moved appointment's old link follows the move. Self-service rescheduling keeps the
  doctor and offers no slot sooner than 2 hours away.

**Replies:**
- **"1"** (or a `appt_confirm` button) confirms the patient's next appointment that had a
  reminder in the last 10 days.
- **"2"** sends the reschedule link when outside the cut-off. Inside it, it opens a
  call-required case and answers "our patient-care team will call you".
- Handled before the chatbot, so the bot never replies to them as well.

## Feature 2.3: online booking widget

**Where:** `/book` (public). The website embeds it with:

```html
<div id="cara-booking" data-branch="" data-service=""></div>
<script src="https://<crm-host>/book/embed.js" async></script>
```

The script forwards the page's UTM tags into an iframe and resizes it. `/book` sends
`Content-Security-Policy: frame-ancestors 'self' <BOOKING_EMBED_ORIGINS>`, so only the
clinic's own site can embed it.

**The flow** (`lib/scheduling/online.ts`, `components/scheduling/BookingWidget.tsx`):
1. Service, then branch, then doctor ("any" or named; hidden for existing-patient
   services).
2. Day and time. Only types marked online-bookable, at least 3 h away and at most 90
   days ahead. **A time that would overbook a doctor or machine is never offered
   online.** That warning is for staff to acknowledge, not the public.
3. **Hold:** the slot is held for 10 minutes (countdown) as a tentative appointment. The
   patient isn't known yet, so the hold sits on one hidden, soft-deleted placeholder
   lead and appears in no list. Same per-resource locks as the desk, so two people
   can't hold one slot. The browser gets a signed hold token.
4. Details and the two consent boxes, both unticked:
   - *appointment messages* — required to book;
   - *marketing* — optional.

   Each is stored as a `ConsentRecord` with the exact text, version, time, IP and
   device.
5. **OTP** (`lib/scheduling/otp.ts`): a WhatsApp authentication template, else DLT SMS.
   Only a hash is stored; it expires in 10 min, allows 5 tries, and 3 sends per phone
   per 15 min. A correct code returns a signed "verified phone" token, valid for one
   purpose for 30 min. The booking uses the phone from that token, never from the form.
   In development only, with no channel configured, the code is shown on screen. In
   production there's no such path: no channel means the widget says "call the clinic".
6. Complete:
   - Find the patient by phone (no duplicates), or create them. Source comes from UTM
     (instagram / facebook / google, else web_form), with the campaign and ad content
     recorded.
   - Stage moves to *appointment scheduled*. The hold moves onto the patient.
   - Status → booked, which starts the 2.4 reminders.
7. **Pay online** (when the type allows it and Razorpay is configured): the patient
   chooses "Pay now ₹X (save Y%)" or "pay at the clinic". Paying creates a Razorpay
   order, opens Checkout, and verifies the signature server-side before
   `BookingPayment` = paid and the appointment is **confirmed**. The appointment card
   shows "paid ₹X online".

Existing-patient services verify the phone first. "Existing" means a completed
appointment or a treatment journey, and the slots shown are their surgeon's.

**Abuse controls:** a honeypot field, IP rate limits on every step, signed tokens for
the slot and the phone, and server-side re-checks of everything.

## Feature 2.7: pre-consultation intake forms

**Building** (setup → Intake forms, `lib/scheduling/intake/schema.ts`):
- Sections of questions: short/long answer, number, date, yes/no, choose one / any,
  guided photos, consent tick, information text.
- Each question can be required, have help text, and be shown only when an earlier
  answer matches ("Thyroid? → Yes → medication and dosage") or only for under-18s.
- Consent ticks each record ONE purpose: health-data processing, treatment photos,
  marketing photos, or guardian. Never bundled.
- The editor checks the form before publishing. Publishing creates a **new immutable
  version**; answers keep the version the patient saw.
- Each appointment type picks its form (Appointment types → "Intake form sent with
  bookings").

**Sending:** the confirmation and day-before messages carry `{intake_link}`. The line
disappears when the type has no form or it's already done. The desk can also hand the
patient a tablet: the card's **Open form for patient**.

**Filling in** (`/f/<token>`, public):
- The link is signed and expires a day after the appointment.
- Nothing personal shows until the patient enters a **code sent to the mobile on
  file**. They never type a number, so a forwarded link is useless.
- Returning patients get their last answers pre-filled; consents and photos are always
  asked fresh.
- Photos are taken per angle on the phone, shrunk to ≤1600 px JPEG in the browser, then
  sent with the answers in one multipart request (`/api/intake-form/submit`). Up to 8 photos,
  2.5 MB each, JPEG/PNG/WebP.

**On submit** (`submitIntake`):
- Answers are validated against that version (hidden questions are dropped and never
  required).
- The verified phone must be the patient's.
- Red flags are computed, and one `ConsentRecord` row is written per consent question
  (text + version + IP + device).
- If any red flag fired, the doctor and branch manager get a bell entry linking to the
  answers.

**Reviewing** (`/appointments/intake/<id>`, `appointments.viewIntake`):
- Red flags first, then every answer labelled **patient-reported** or **verified**.
  Clinicians (`appointments.verifyIntake`) confirm answers one by one.
- Also shows the photos and the consents given.
- Opening it is audited as a record view.
- The calendar list and board show *form pending* / *intake complete* (with a red-flag
  marker). Front desk sees status only; answers are health data.

## Feature 2.8: treatment series and recall

**Templates** (`SeriesTemplate`, setup → Treatment series):
- Steps measured from the anchor (Day 0): name, appointment type, offset in **days or
  calendar months** (Month 1 after 12 Oct is 12 Nov; 31 Jan + 1 month is the last day
  of February), tolerance ±days, and whether it's with the surgeon.
- Optional: the anchor appointment type, the package name (as written on the quote's
  treatment), and **automatic start**.

**A patient's plan** (`TreatmentPlan` + `PlannedStep`, `lib/scheduling/series.ts`):
- **Starts:**
  - automatically, when an appointment of the anchor type is booked for a patient
    with a converted quote for that package (once per patient per series);
  - or by hand, from any appointment card ("Start plan from this appointment").
- The anchor appointment becomes step 1. Its doctor becomes the plan's surgeon and its
  branch the plan's branch.
- **Pre-booking (2.8.b):** each step targeted within 30 days is booked on the target
  day, else the nearest day inside its window, with the surgeon. It prefers the anchor's
  time of day and never accepts an overbooking warning. A step that can't be fitted
  stays *planned*.
- **Follows its appointments:**

  | Appointment event | Effect on the plan |
  |---|---|
  | A step is rescheduled | The step follows the new row |
  | The anchor is rescheduled | Every later step's target and window shift. Booked steps outside their new window are re-booked into it, same surgeon. The plan is flagged *needs review* ("Anchor moved from 12 Oct to 19 Oct — confirm the shifted follow-ups") and the branch manager is told |
  | A step is completed | Marked completed, progress updates ("4 of 6"), and a `series.step.completed` audit event is written for Billing (3.4) to recognise revenue |
  | A step is cancelled / a no-show | Goes back to *planned* and recall picks it up again |

- **Per-patient edits** (`/appointments/plans/<id>`, never touching the template):
  - book a step;
  - **extend** its window (+days, reason);
  - **waive** it (reason);
  - **change the target date**;
  - set the surgeon (pre-books what's due within 30 days);
  - mark reviewed;
  - cancel the plan (reason).

**Recall** (hourly worker tick, `processRecalls`, quiet hours respected):

| When (from the window opening) | What happens |
|---|---|
| Day 0 | WhatsApp: the `recall_due` message, "Your PRP session 1 is due between 3 Nov and 17 Nov. Tap to choose a time: {recall_link}" |
| Day 3 | WhatsApp + SMS |
| Day 7 | A **call task**: the step shows *call required* on the recall list, and the branch manager gets a bell entry |

- **The recall link** (`/r/<token>`, public, signed, valid 30 days past the window)
  shows the window and free times with the surgeon, at the plan's branch or any other
  (2.8.e). Booking it books the step.
- **Recall list** (`/appointments/recall`): every unbooked step that is **overdue**,
  **due this week** or **due in the next 30 days**, with recall progress and
  call-required flags. Branch-scoped unless you see all branches.

## Reschedule, status, holds

- **Reschedule never edits the time in place.** The old row becomes `rescheduled`, its
  resources are released, and a **new** row points back via `rescheduledFromId`. "When
  was I told my slot changed" is a chain of rows (1.E). Only the named surgeon carries
  over; everything else is re-allocated. The new slot starts as `booked`, so a confirmed
  patient confirms again.
- **Status changes** follow `STATUS_TRANSITIONS` in
  [lib/scheduling/status.ts](../../lib/scheduling/status.ts). Each status stamps its own
  timestamp (`checkedInAt`, `completedAt`, …). The update is guarded on the status that
  was read, so two people can't both apply a change. **Cancel needs a reason and who
  cancelled** (patient / clinic). Cancelled, rescheduled and no-show release the
  resources (`blocking = false`); the rows stay for history.
- **Tentative holds** (`holdMinutes`) lapse via `expireHolds()`, which the worker runs
  every minute. It cancels the hold with reason "Hold expired".

## Setup screen: `/appointments/setup`

Gated to `appointments.configure`. Every change is audited.

| Tab | What it does |
|---|---|
| Switches | The six module toggles (below) |
| Hours & holidays | Weekly hours per branch. A branch with no hours uses **09:00–20:00 every day**. Closures can be one branch or all, a date range, and whole-day or part-day |
| Resources & rosters | Doctors, rooms, equipment, support staff. Rooms/equipment belong to one branch; people can work across branches. Weekly roster per person (branch + day + hours). Leave / downtime. Adding leave **doesn't cancel** existing bookings; it says how many need rebooking |
| Appointment types | Duration, turnover buffer, catalog link, online-bookable, prep instructions, requirements (kind + optional type + quantity, or a specific resource). Edits apply to **new** bookings only |
| Patient flags | Admin-defined flags (label, drawn icon, tag colour). ★ **Priority** is seeded |

## Key files

| File | Role |
|---|---|
| `prisma/schema.prisma` (Module 3.2 block) + migration `20261008052416_scheduling_foundation` | `BranchHours`, `BranchClosure`, `Resource`, `ResourceSchedule`, `ResourceTimeOff`, `AppointmentType`, `AppointmentTypeRequirement`, `Appointment`, `AppointmentResource`, `FlagDefinition`, `LeadFlag` |
| `lib/scheduling/engine.ts` | Pure conflict engine: `evaluateSlot`, `findSlots`, `resourceIssues` |
| `lib/scheduling/booking.ts` | `bookAppointment`, `rescheduleAppointment`, `changeAppointmentStatus`, `previewBooking`, `findSlots`, `expireHolds` |
| `lib/scheduling/hours.ts` | Branch week + day (hours, closures, default) |
| `lib/scheduling/status.ts` | Statuses, transitions, resource kinds |
| `lib/scheduling/toggles.ts` | Switch keys, labels, defaults (read through `lib/settings.ts`) |
| `lib/scheduling/time.ts` | IST wall-clock ↔ instant |
| `lib/scheduling/flags.ts` | Flag icon / tone vocabulary |
| `app/(dashboard)/appointments/setup/` | Setup page + server actions |
| `app/(dashboard)/appointments/` + `components/scheduling/SlotFinder.tsx` | Find a slot |
| migration `20261008070455_scheduling_room_override` | `Resource.allowOverride`, `Appointment.overrideReason/overriddenById` |
| migration `20261008074655_scheduling_cross_branch` | `ResourceScheduleException`, `BranchTravelTime` |
| `lib/scheduling/reminders.ts`, `messageText.ts`, `links.ts` | Reminder engine, message text (pure), signed patient links |
| `lib/providers/sms.ts`, `lib/providers/email.ts` | Plivo DLT SMS, AWS SES email |
| `app/(public)/a/[token]/` + `components/scheduling/PatientAppointment.tsx` | The patient's page + actions; `lib/publicPaths.ts` lets it past the login gate |
| `components/scheduling/MessagesSetup.tsx` | Setup → Messages & reminders |
| migration `20261008091247_scheduling_reminders` | `AppointmentMessageTemplate` (+ 7 seeded), `ReminderRule`, `AppointmentReminder`, `AppointmentType.selfServiceCutoffHours` |
| `lib/scheduling/online.ts`, `otp.ts`, `lib/providers/razorpay.ts` | Online booking service, OTP, Razorpay |
| `app/(public)/book/` (+ `embed.js`) + `components/scheduling/BookingWidget.tsx` | The widget |
| migration `20261008095433_scheduling_online_booking` | `OtpChallenge`, `ConsentRecord`, `BookingPayment`, online fields on `AppointmentType` |
| `lib/scheduling/intake/schema.ts`, `intake/service.ts` | Form schema/logic (pure) + intake service |
| `app/(public)/f/[token]/`, `app/api/intake-form/submit/`, `app/api/intake-form/photo/[id]/` | Patient form, submit, staff-only photos |
| `app/(dashboard)/appointments/intake/[id]/` | Staff view + verification |
| `components/scheduling/IntakeFormsSetup.tsx`, `IntakeFormView.tsx` | Builder, patient form |
| migration `20261008101458_scheduling_intake_forms` | `IntakeForm`, `IntakeFormVersion`, `IntakeResponse`, `IntakePhoto`, `AppointmentType.intakeFormId`; adds `{intake_link}` to the seeded messages |
| `lib/scheduling/series.ts` | Plans, offsets/windows, pre-booking, anchor shift, step status, recall, recall list |
| `app/(dashboard)/appointments/plans/`, `…/recall/`, `app/(public)/r/[token]/` | Plan page, recall list, patient recall booking |
| `components/scheduling/SeriesSetup.tsx`, `PlanView.tsx`, `RecallBooking.tsx` | Setup, plan, recall link UI |
| migration `20261008103714_scheduling_treatment_series` | `SeriesTemplate`, `SeriesStep`, `TreatmentPlan`, `PlannedStep`, + the `recall_due` message |
| `lib/scheduling/leave.ts` | Request / approve / reject / withdraw leave, emergency |
| `lib/scheduling/conflicts.ts` | Conflict detection, rebooking cases, suggestions, apply, escalation, closures |
| `lib/scheduling/notify.ts` | Messaging a patient about a change (WhatsApp today; 2.4 extends it) |
| `app/(dashboard)/appointments/leave/`, `…/rebooking/` | The two screens + their actions |
| migration `20261008082550_scheduling_leave_sync` | leave status/kind/decision on `ResourceTimeOff`, contract dates on `Resource`, `RebookingCase`, `Notification.href` |
| `lib/scheduling/calendar.ts` | Viewer + privacy, appointments for a range, day columns, week roster, summary |
| `components/scheduling/desk/*` | The desk: shell/toolbar, views, booking drawer, appointment card |
| `components/scheduling/*` | Setup tab components |
| `scripts/checkScheduling.ts` | `npm run check:scheduling`: 39 checks: engine, spec 2.1 incl. the worked example, database concurrency / reschedule / override |

## Configuration

**Switches** (AppSetting rows, global, audited as `toggle.change`):

| Key | Default | Effect |
|---|---|---|
| `scheduling.enabled` | on | Master. Off = every booking write is refused |
| `scheduling.allowDoctorDoubleBooking` | on | Off = doctors block like rooms |
| `scheduling.enforceBranchHours` | on | Off = hours/holidays only warn |
| `scheduling.enforceStaffRosters` | on | Off = rosters and leave only warn |
| `scheduling.requireSupportStaff` | on | Off = staff requirements are ignored |
| `scheduling.blockEquipment` | **off** | On = equipment blocks like a room |
| `scheduling.defaultTravelMinutes` | 90 | Travel time for any branch pair without its own |
| `scheduling.remindersEnabled` | **off** | Sending reminders at all |
| `scheduling.selfServiceLinks` | on | The patient link can change the appointment |
| `scheduling.quietStartHour` / `quietEndHour` | 21 / 8 | Reminder quiet hours (IST) |
| `scheduling.recallEnabled` | **off** | Treatment-plan recall messages (the recall list works regardless) |
| `scheduling.onlineBooking` | on | The /book widget (nothing shows until a type is online-bookable) |
| `scheduling.onlineMinNoticeHours` / `onlineMaxDays` / `onlineHoldMinutes` | 3 / 90 / 10 | Online lead time and hold |

Environment for 2.4 (all optional; each channel stays off without its own):
`APP_BASE_URL`, `PLIVO_SMS_SENDER` + `PLIVO_DLT_ENTITY_ID`, and `SES_REGION` +
`SES_FROM_EMAIL` (+ keys).
| `scheduling.patientFlags` | on | Flags on cards (used from Phase B) |

**Capabilities** (new; run `npm run backfill:capabilities` in prod for customised roles):

| Capability | Default holders |
|---|---|
| `appointments.view` | front desk, telecaller, telecalling head, branch manager, sales head, doctor, OT team, post-sales consultant |
| `appointments.book` | front desk, telecaller, telecalling head, branch manager, post-sales consultant |
| `appointments.checkin` | front desk, branch manager, doctor |
| `appointments.configure` | branch manager (+ admin) |
| `appointments.override` | branch manager (+ admin) |
| `appointments.viewAllBranches` | telecaller, telecalling head, branch manager, sales head (+ admin) |
| `appointments.bookAnyBranch` | telecaller, telecalling head, branch manager, sales head (+ admin) |
| `appointments.approveLeave` | sales head (+ admin) |
| `appointments.viewIntake` | doctor, post-sales consultant, branch manager (+ admin) |
| `appointments.verifyIntake` | doctor, post-sales consultant (+ admin) |

> **Run `npm run backfill:capabilities` after deploying.** Roles customised in the
> Hierarchy screen don't get new capabilities by themselves. Locally, `front_desk` was
> customised and was redirected away from `/appointments` until the backfill ran.

## Limitations

- **No booking UI yet.** Find a slot is read-only. Booking, and the override button,
  arrive with the calendar in Phase B.
- **Before go-live, reminders need:** approved WhatsApp templates for each message
  (Meta), DLT sender/entity/template ids for SMS (Jatin), and SES for email. Then the
  clinic switches "Send appointment reminders" on.
- **Online booking needs an OTP channel in production:** `WHATSAPP_OTP_TEMPLATE` (a
  Meta-approved authentication template), or DLT SMS. Until then `/book` says "call the
  clinic".
- **No CAPTCHA yet:** honeypot + rate limits + OTP only. Turnstile can be added if bots
  appear.
- **Prepayment doesn't reach billing (3.4) yet.** It's recorded on the appointment, not
  invoiced. Refunds happen in the Razorpay dashboard.
- **Series templates come from the clinical lead.** Nothing is pre-loaded; the demo
  series exists only in local data.
- **Revenue recognition is an audit event**, not an invoice entry, until Billing (3.4)
  consumes it.
- **Automatic start matches the package by quote treatment name** (case-insensitive),
  because quotes don't carry a catalogue id yet.
- **Plans don't show on the lead page yet** (they're reached from the appointment card,
  the recall list and the bell).
- **Intake forms are English only, and partial answers live only in the browser.** A
  patient who closes the page halfway starts again; there's no autosave.
- **No paper-scan upload** for a patient who filled in a paper form. The tablet route
  works; a scan goes to 3.12.
- **No EMR mapping yet.** Each question carries an `emr` hint (allergies / medications /
  conditions) for 3.3, but nothing is written into an EMR.
- **Photos are stored in the database** (≤8 × 2.5 MB per form) until 3.12's document
  store exists.
- **No PDF attachment.** The 7-day surgery email carries the checklist as text (the
  type's preparation instructions), not as a PDF.
- **Rebooking messages (2.9) are still free text**, so they only reach a patient inside
  the 24 h window; outside it, the case says "call the patient". A free-text "no" to a
  rebooking isn't parsed; staff mark "Patient declined — call required".
- **Changing a type's timeline doesn't touch appointments already booked**; they keep
  their reminders.
- **Branches without a manager** have unassigned cases. They still escalate to admins
  and the Sales Head.
- **No HR integration** (3.8 isn't built): leave is requested here, not in HR.
- **Equipment can't move between branches** (2.2.d); changing a machine's branch is an
  audited edit.
- **Chain search is a straightforward loop** (branches × days). Fine at today's
  scale; worth caching if the chain grows past ~10 branches.
- **Resource columns scroll horizontally** past ~6 columns; there's no column picker yet.
- **Find a slot checks one named doctor.** "Show me every surgeon's free days" isn't
  offered, by decision 2.1.d (patients book a specific surgeon).
- **Room-level minimum turnover isn't modelled.** Buffers are per appointment type only
  (2.1.b).
- **The master switch** refuses writes and hides the Appointments menu item; the setup
  screen stays reachable so it can be switched back on.
- **A doctor's "home branch" isn't enforced without a roster.** A doctor with no roster is
  bookable at any branch while it's open. Give them a roster to pin them down.
- **Leave from HR (3.8) and machine downtime from Assets (3.9) aren't connected.**
  `ResourceTimeOff.source` is ready for them; today it is entered by hand.
- **Adding leave doesn't move existing bookings.** It reports the count; a person
  rebooks them.
- **One appointment = one IST day.** Multi-day work is a treatment series (Phase D).
- **The lead-access scope isn't widened for booking yet.** Front desk is "own leads" scope
  today, and Phase B's patient search has to deal with that.

## What's next

- **Phase B, front desk:** day list grouped by hour; consultant timeline with the "now"
  line; appointment card (flags, status, notes, actions); book / move / cancel /
  check-in; day summary bar; live front-desk board (1.B); lead stage → appointment
  scheduled.
- **Phase C, automation:** confirmations, 24h/2h WhatsApp reminders, reply-to-confirm,
  automatic no-show after a grace period.
- **Phase D, series & recall:** package → linked appointments from the anchor date
  (`PostSalesJourney.surgeryAt`).
- **Phase E, self-service & reach:** patient booking link, intake forms, cross-branch
  call-centre view, utilisation and no-show reports.
