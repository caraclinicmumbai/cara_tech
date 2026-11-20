# 16 — Personal calendar (`/calendar`)

Dr. Asif's suggestion (2026-11-20), built alongside the appointment calendars: every person
in the organisation has one calendar showing their appointments and their tasks together,
and can block time on it. Sidebar → **My calendar**.

## What's on it

| Item | Whose | Where it comes from |
|---|---|---|
| **Appointments** (consultations and treatments) | A doctor or staff member — a login linked to a resource in Scheduling setup | `Appointment`, through the person's `Resource`. The appointments desk's privacy rule applies: another branch's patient shows as "Booked" |
| **Lead follow-ups** | A counsellor — a login linked to a sales rep | Pending `LeadFollowUpStep`s they own, on leads not deleted or lost (the same set the follow-up reminders use). Tick one done from the calendar |
| **Tasks** | Anyone | `Task` — set by the person themselves or by any colleague |
| **Blocked time** | Anyone | `TimeBlock` — training, lunch / dinner break, unavailable, other |

Above the calendar: **Overdue** (one-time tasks past due, and how many lead follow-ups are past
due, with a link to My numbers), and **Tasks I've set for others** that are still open.

## Tasks

- A task has a title, optional notes, who it's for, a due date, and either a time or **any time
  that day** (`allDay`).
- **Repeats** (`lib/calendar/recurrence.ts`, pure): does not repeat, every day, every week (same
  weekday), every month (same date — the 31st falls on the month's last day when the month is
  shorter). Optional end date. A repeating task's occurrences are ticked **one day at a time**
  (`TaskDone`); a one-time task is closed on its row.
- **Who may set one for whom:** anyone for anyone (clinic decision, 2026-11-20). The person gets a
  bell notification linking to that day on their calendar.
- **Tick:** the person it's for, whoever set it, or an admin. **Delete** (every repeat): whoever
  set it, or an admin — so a task a manager sets can't be deleted by the person, only done.
- Overdue: a timed task after its time, an all-day task after its day.

## Blocking time

- **Drag across empty time** on the day, week or timeline view (snaps to 15 minutes), or use
  **+ Block time** for whole days. A plain click on empty time offers a task at that time instead.
- Kinds: Training, Lunch / dinner break, Unavailable, Other, plus an optional note. Up to 7 days;
  longer is leave (Appointments → Leave, which has approval).
- **Only the person themselves** blocks their time (an admin may for anyone). A manager looking at
  someone's calendar can set them a task but not block their time.
- **For a doctor or staff member, a block stops bookings** (clinic decision, 2026-11-20). It is
  mirrored as approved `ResourceTimeOff` (`source = "calendar"`, kind = the block's kind), so Find a
  slot, the online widget and the booking engine treat it exactly like leave, and any appointment
  already booked in it goes to **Needs rebooking**. It shows on Appointments → Leave too.
  Removing the block cancels that time off and re-checks the rebooking cases it opened. Withdrawing
  it from the leave screen hides the block from the calendar.
- For anyone else (telecallers, front desk) a block is for their own planning only.

## Seeing someone else's calendar

`calendar.viewOthers` (Hierarchy → Calendar). Granted by default to Telecalling Head, Branch
Manager and Sales Head (+ Admin). They get a person picker; `?user=` without the capability shows
your own calendar. The migration adds the capability to roles an admin had already customised.

## Views

All in the URL (`view`, `date`, `user`), like the appointments desk.

| View | Layout |
|---|---|
| **List** | The week as an agenda, a row per day |
| **Day** | Vertical: hours down the side, one column, an all-day strip on top |
| **Week** (default) | Vertical, seven columns Monday–Sunday |
| **Timeline** | Horizontal: hours across, a row per day of the week |

Colours: appointments by status (as on the appointments desk), follow-ups orange, tasks blue,
done green, overdue pink, blocked time hatched grey.

## Audit

`task.create`, `task.done` / `task.undone` (with the occurrence for a repeating task),
`task.delete`, `calendar.block`, `calendar.unblock`.

## Not built (yet)

- Editing a task or block in place (delete and re-add).
- Reports on tasks (done on time, overdue by person).
- Slack reminders for tasks (the bell fires when one is set, not when it falls due).
- Appointments a telecaller *booked* (the calendar shows only appointments the person is booked on
  as a doctor or staff member).

## Key files

| File | Role |
|---|---|
| `lib/calendar/service.ts` | Load a person's calendar; create / tick / delete tasks; block and unblock time |
| `lib/calendar/recurrence.ts` | When a repeating task falls due |
| `lib/calendar/types.ts` | Shapes sent to the browser, block kinds, views |
| `app/(dashboard)/calendar/` | Page + server actions |
| `components/calendar/PersonalCalendar.tsx` | The four views, drag-to-block, dialogs |
| `prisma/migrations/20261120130000_personal_calendar` | `Task`, `TaskDone`, `TimeBlock`; grants `calendar.viewOthers` |
