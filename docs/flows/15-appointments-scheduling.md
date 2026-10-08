# 15 — Appointments & scheduling (Module 3.2)

One real-time system to book, move, confirm and run appointments across every branch,
so that **no room, machine or member of support staff is ever double-booked**. Doctors
may be double-booked, but only after a warning someone acknowledged, and that is
recorded.

> **This build is Phase A, the foundation:** the data model, the conflict engine, the
> booking service, and the setup screen. Nothing in the UI books an appointment yet:
> the front-desk calendar (day list, timeline, appointment card, check-in board) is
> Phase B. See [What's next](#whats-next).

## Decisions taken (2026-10-08)

| # | Decision | Outcome |
|---|---|---|
| 1.A | Status lifecycle | Adopted as written: tentative → booked → confirmed → checked-in → in progress → completed, plus rescheduled / cancelled / no-show |
| 1.B | Front-desk board | In: Phase B |
| 1.C | Branch hours, holidays, blackouts | In: built here |
| 1.D | Support staff as a resource | In, for **every** appointment type, not only surgery |
| 1.E | Booking audit trail | In: every write goes to the hash-chained `AuditLog` |
| — | Doctor double-booking | Allowed, with a warning that has to be acknowledged (switchable) |
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
| Room / equipment / staff already booked | **block, always** |
| Doctor already booked | warn + acknowledge (block if "Allow doctors to be double-booked" is off) |
| Outside branch hours, closed day, holiday, part-day closure | block (warn if "Enforce branch hours" is off) |
| Doctor/staff outside their roster at this branch | block (warn if "Enforce rosters" is off) |
| Doctor/staff on leave | block (warn if rosters aren't enforced) |
| Room/equipment downtime | block, always |
| Room/equipment from another branch | block |
| Not enough free resources for a requirement ("needs 2 technicians, only 1 free") | block |
| Start in the past (unless back-dating a walk-in) | block |
| Runs past midnight | block (a multi-day surgery is a series, not one row) |

Two subtleties:
- **Intervals are half-open.** 11:00–12:00 and 12:00–12:30 don't clash.
- **Auto-fill never silently picks an overbooked doctor.** Only a resource with nothing in
  the way is auto-assigned. Overbooking only happens when a person picks that doctor
  and acknowledges it.

## Reschedule, status, holds

- **Reschedule never edits the time in place.** The old row becomes `rescheduled`, its
  resources are released, and a **new** row points back via `rescheduledFromId`. "When
  was I told my slot changed" is a chain of rows (1.E). The same people and rooms carry
  over unless new ones are chosen. The new slot starts as `booked`, so a confirmed patient
  confirms again.
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
| `components/scheduling/*` | Setup tab components |
| `scripts/checkScheduling.ts` | `npm run check:scheduling`: 21 engine checks + 5 database checks |

## Configuration

**Switches** (AppSetting rows, global, audited as `toggle.change`):

| Key | Default | Effect |
|---|---|---|
| `scheduling.enabled` | on | Master. Off = every booking write is refused |
| `scheduling.allowDoctorDoubleBooking` | on | Off = doctors block like rooms |
| `scheduling.enforceBranchHours` | on | Off = hours/holidays only warn |
| `scheduling.enforceStaffRosters` | on | Off = rosters and leave only warn |
| `scheduling.requireSupportStaff` | on | Off = staff requirements are ignored |
| `scheduling.patientFlags` | on | Flags on cards (used from Phase B) |

**Capabilities** (new; run `npm run backfill:capabilities` in prod for customised roles):

| Capability | Default holders |
|---|---|
| `appointments.view` | front desk, telecaller, telecalling head, branch manager, sales head, doctor, OT team, post-sales consultant |
| `appointments.book` | front desk, telecaller, telecalling head, branch manager, post-sales consultant |
| `appointments.checkin` | front desk, branch manager, doctor |
| `appointments.configure` | branch manager (+ admin) |

## Limitations

- **No booking UI yet.** The engine and service are complete and tested, but there is no
  calendar to call them from until Phase B.
- **The master switch doesn't hide anything yet**, because there is nothing to hide. It
  refuses writes today; once the calendar exists it will hide the module too.
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
