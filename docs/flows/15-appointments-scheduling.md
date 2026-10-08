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

> **Run `npm run backfill:capabilities` after deploying.** Roles customised in the
> Hierarchy screen don't get new capabilities by themselves. Locally, `front_desk` was
> customised and was redirected away from `/appointments` until the backfill ran.

## Limitations

- **No booking UI yet.** Find a slot is read-only. Booking, and the override button,
  arrive with the calendar in Phase B.
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
