// The personal calendar (/calendar): one person's appointments, lead follow-ups, tasks
// and blocked time, over a range of IST days.
//
// Everyone has their own. A manager (`calendar.viewOthers`) can open a colleague's. Tasks
// can be set by anyone for anyone. Time can be blocked only by the person themselves (an
// admin may for anyone); for a doctor or staff member it is also time off, so booking
// treats it like leave.
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { writeAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notifications";
import type { SessionUser } from "@/lib/authz";
import { loadAppointments, viewerFor } from "@/lib/scheduling/calendar";
import { detectConflicts, recheckOpenCases } from "@/lib/scheduling/conflicts";
import { istDateKey, istInstant, istMinutes } from "@/lib/scheduling/time";
import { addDayKeys, fallsOn, isTaskRepeat, occurrencesBetween, type TaskRepeat } from "@/lib/calendar/recurrence";
import {
  BLOCK_KIND_LABELS,
  isBlockKind,
  type CalBlock,
  type CalendarData,
  type CalTask,
} from "@/lib/calendar/types";

type Result = { ok: boolean; error?: string; info?: string };

const DAY_MS = 86_400_000;
/// Longer than this is leave, which has its own request and approval.
const MAX_BLOCK_DAYS = 7;
const KEY = /^\d{4}-\d{2}-\d{2}$/;

const isAdmin = (u: SessionUser) => u.role === "crm_admin";

/// May `viewer` open `ownerId`'s calendar?
export function maySeeCalendar(viewer: SessionUser, ownerId: string): boolean {
  return viewer.id === ownerId || can(viewer.role, "calendar.viewOthers");
}

// ── Reading ────────────────────────────────────────────────────────────────────

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  assigneeId: string;
  createdById: string | null;
  dueAt: Date;
  allDay: boolean;
  repeat: string;
  repeatUntil: Date | null;
  status: string;
  assignee: { name: string | null; email: string };
  createdBy: { name: string | null; email: string } | null;
  done: { occurrence: string }[];
};

const TASK_SELECT = {
  id: true,
  title: true,
  notes: true,
  assigneeId: true,
  createdById: true,
  dueAt: true,
  allDay: true,
  repeat: true,
  repeatUntil: true,
  status: true,
  assignee: { select: { name: true, email: true } },
  createdBy: { select: { name: true, email: true } },
} as const;

const who = (u: { name: string | null; email: string } | null) => (u ? u.name || u.email : "someone");

/// The IST day a task's occurrence ends — an all-day task is due by the end of its day.
function occurrenceAt(t: TaskRow, key: string): Date {
  return istInstant(key, t.allDay ? 0 : istMinutes(t.dueAt));
}

function isOverdue(t: TaskRow, key: string, done: boolean, now: Date): boolean {
  if (done) return false;
  const due = t.allDay ? istInstant(addDayKeys(key, 1), 0) : occurrenceAt(t, key);
  return due.getTime() < now.getTime();
}

function toCalTask(t: TaskRow, key: string, viewer: SessionUser, ownerId: string, now: Date): CalTask {
  const repeat = isTaskRepeat(t.repeat) ? t.repeat : "none";
  const done = repeat === "none" ? t.status === "done" : t.done.some((d) => d.occurrence === key);
  return {
    kind: "task",
    id: t.id,
    occurrence: key,
    at: occurrenceAt(t, key).toISOString(),
    allDay: t.allDay,
    title: t.title,
    notes: t.notes,
    repeat,
    done,
    overdue: isOverdue(t, key, done, now),
    assignedBy: t.createdById && t.createdById !== t.assigneeId ? who(t.createdBy) : null,
    assignedTo: t.assigneeId !== ownerId ? who(t.assignee) : null,
    canTick: viewer.id === t.assigneeId || viewer.id === t.createdById || isAdmin(viewer),
    canDelete: viewer.id === t.createdById || isAdmin(viewer) || (t.createdById === null && viewer.id === t.assigneeId),
  };
}

export async function loadCalendar(
  viewer: SessionUser,
  ownerId: string,
  fromKey: string,
  toKey: string,
): Promise<CalendarData | null> {
  if (!maySeeCalendar(viewer, ownerId)) return null;
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { id: true, name: true, email: true, salesRepId: true, schedulingResource: { select: { id: true } } },
  });
  if (!owner) return null;

  const now = new Date();
  const from = istInstant(fromKey, 0);
  const to = istInstant(addDayKeys(toKey, 1), 0);
  const resourceId = owner.schedulingResource?.id ?? null;
  const fromDay = new Date(`${fromKey}T00:00:00Z`);

  const [appts, followUps, overdueFollowUps, taskRows, overdueRows, byMeRows, blockRows] = await Promise.all([
    resourceId ? loadAppointments(await viewerFor(viewer), from, to, { branchId: null, doctorId: resourceId }) : [],
    owner.salesRepId
      ? prisma.leadFollowUpStep.findMany({
          where: { ownerRepId: owner.salesRepId, status: "pending", dueAt: { gte: from, lt: to }, lead: { deletedAt: null, stage: { not: "lost" } } },
          orderBy: { dueAt: "asc" },
          take: 300,
          select: { id: true, title: true, dueAt: true, lead: { select: { id: true, name: true } } },
        })
      : [],
    owner.salesRepId
      ? prisma.leadFollowUpStep.count({
          where: { ownerRepId: owner.salesRepId, status: "pending", dueAt: { lt: now }, lead: { deletedAt: null, stage: { not: "lost" } } },
        })
      : 0,
    prisma.task.findMany({
      where: {
        assigneeId: ownerId,
        deletedAt: null,
        dueAt: { lt: to },
        OR: [
          { repeat: "none", dueAt: { gte: from } },
          { repeat: { not: "none" }, OR: [{ repeatUntil: null }, { repeatUntil: { gte: fromDay } }] },
        ],
      },
      select: { ...TASK_SELECT, done: { where: { occurrence: { gte: fromKey, lte: toKey } }, select: { occurrence: true } } },
    }),
    prisma.task.findMany({
      where: { assigneeId: ownerId, deletedAt: null, repeat: "none", status: "open", dueAt: { lt: now } },
      orderBy: { dueAt: "asc" },
      take: 100,
      select: { ...TASK_SELECT, done: { select: { occurrence: true }, take: 0 } },
    }),
    prisma.task.findMany({
      where: { createdById: ownerId, assigneeId: { not: ownerId }, deletedAt: null, status: "open" },
      orderBy: { dueAt: "asc" },
      take: 100,
      select: { ...TASK_SELECT, done: { select: { occurrence: true }, take: 0 } },
    }),
    prisma.timeBlock.findMany({
      where: { userId: ownerId, removedAt: null, startAt: { lt: to }, endAt: { gt: from } },
      orderBy: { startAt: "asc" },
    }),
  ]);

  // A block whose time off was withdrawn from the leave screen is no longer a block.
  const offIds = blockRows.map((b) => b.timeOffId).filter((x): x is string => !!x);
  const liveOff = new Set(
    offIds.length
      ? (await prisma.resourceTimeOff.findMany({ where: { id: { in: offIds }, status: "approved" }, select: { id: true } })).map((o) => o.id)
      : [],
  );

  const tasks: CalTask[] = [];
  for (const t of taskRows as TaskRow[]) {
    const repeat = (isTaskRepeat(t.repeat) ? t.repeat : "none") as TaskRepeat;
    const until = t.repeatUntil ? t.repeatUntil.toISOString().slice(0, 10) : null;
    for (const key of occurrencesBetween(istDateKey(t.dueAt), repeat, until, fromKey, toKey)) {
      tasks.push(toCalTask(t, key, viewer, ownerId, now));
    }
  }
  tasks.sort((a, b) => a.at.localeCompare(b.at) || Number(b.allDay) - Number(a.allDay));

  const blocks: CalBlock[] = blockRows
    .filter((b) => !b.timeOffId || liveOff.has(b.timeOffId))
    .map((b) => ({
      kind: "block",
      id: b.id,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      blockKind: b.kind,
      label: isBlockKind(b.kind) ? BLOCK_KIND_LABELS[b.kind] : b.kind,
      note: b.note,
      blocksBookings: !!b.timeOffId,
      canRemove: viewer.id === ownerId || isAdmin(viewer),
    }));

  return {
    owner: {
      id: owner.id,
      name: owner.name || owner.email,
      isSelf: viewer.id === ownerId,
      hasResource: !!resourceId,
      hasRep: !!owner.salesRepId,
    },
    fromKey,
    toKey,
    appointments: appts.map((a) => ({
      kind: "appointment",
      id: a.id,
      startAt: a.startAt,
      endAt: a.endAt,
      title: a.patientName ?? "Booked",
      detail: [a.typeName, a.branchName].filter(Boolean).join(" · "),
      status: a.status,
      href: `/appointments?view=list&branch=all&date=${istDateKey(new Date(a.startAt))}&doctor=${resourceId}`,
    })),
    followUps: followUps.map((f) => ({
      kind: "followup",
      id: f.id,
      leadId: f.lead.id,
      at: f.dueAt!.toISOString(),
      title: f.title,
      leadName: f.lead.name,
      overdue: f.dueAt!.getTime() < now.getTime(),
    })),
    tasks,
    blocks,
    overdueTasks: (overdueRows as TaskRow[])
      .map((t) => toCalTask(t, istDateKey(t.dueAt), viewer, ownerId, now))
      .filter((t) => t.overdue),
    overdueFollowUps,
    assignedByMe: (byMeRows as TaskRow[]).map((t) => toCalTask(t, istDateKey(t.dueAt), viewer, ownerId, now)),
  };
}

/// Everyone a task can be set for (any active login), for the picker.
export async function taskAssignees(): Promise<{ id: string; label: string }[]> {
  const users = await prisma.user.findMany({ orderBy: [{ name: "asc" }, { email: "asc" }], select: { id: true, name: true, email: true } });
  return users.map((u) => ({ id: u.id, label: u.name || u.email }));
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

export async function createTask(
  actor: SessionUser,
  input: { assigneeId: string; title: string; notes?: string; date: string; time?: string; repeat?: string; repeatUntil?: string },
): Promise<Result> {
  if (!actor.id) return { ok: false, error: "Not signed in" };
  const title = input.title?.trim();
  if (!title) return { ok: false, error: "Give the task a title" };
  if (title.length > 200) return { ok: false, error: "Keep the title under 200 characters" };
  if (!KEY.test(input.date ?? "")) return { ok: false, error: "Pick a date" };
  const time = input.time?.trim() ?? "";
  let minutes = 0;
  if (time) {
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: "That isn't a valid time" };
    minutes = Number(m[1]) * 60 + Number(m[2]);
  }
  const repeat = input.repeat || "none";
  if (!isTaskRepeat(repeat)) return { ok: false, error: "Pick how often it repeats" };
  const until = repeat !== "none" && input.repeatUntil?.trim() ? input.repeatUntil.trim() : null;
  if (until && (!KEY.test(until) || until < input.date)) return { ok: false, error: "The repeat end must be on or after the first date" };

  const assignee = await prisma.user.findUnique({ where: { id: input.assigneeId }, select: { id: true, name: true, email: true } });
  if (!assignee) return { ok: false, error: "Pick who it's for" };

  const task = await prisma.task.create({
    data: {
      title,
      notes: input.notes?.trim() || null,
      assigneeId: assignee.id,
      createdById: actor.id,
      dueAt: istInstant(input.date, minutes),
      allDay: !time,
      repeat,
      repeatUntil: until ? new Date(`${until}T00:00:00Z`) : null,
    },
    select: { id: true, dueAt: true },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "task.create",
    entityType: "task",
    entityId: task.id,
    newValue: `${title} → ${assignee.name || assignee.email} (${input.date}${time ? ` ${time}` : ""}, ${repeat})`,
  });
  if (assignee.id !== actor.id) {
    await notifyUser({
      userId: assignee.id,
      kind: "task",
      title: `New task from ${actor.name || actor.email || "a colleague"}: ${title}`,
      body: `Due ${input.date}${time ? ` at ${time}` : ""}${repeat !== "none" ? ` · repeats ${repeat}` : ""}`,
      href: `/calendar?date=${input.date}`,
      dedupeKey: `task:${task.id}`,
    });
  }
  return { ok: true, info: assignee.id === actor.id ? "Task added" : `Task set for ${assignee.name || assignee.email}` };
}

/// Tick (or untick) a task — one occurrence of a repeating one.
export async function setTaskDone(actor: SessionUser, taskId: string, occurrence: string, done: boolean): Promise<Result> {
  const t = await prisma.task.findFirst({
    where: { id: taskId, deletedAt: null },
    select: { id: true, title: true, assigneeId: true, createdById: true, dueAt: true, repeat: true, repeatUntil: true },
  });
  if (!t) return { ok: false, error: "Task not found" };
  if (actor.id !== t.assigneeId && actor.id !== t.createdById && !isAdmin(actor)) return { ok: false, error: "Only the person it's for, or who set it, can tick it" };

  if (t.repeat === "none") {
    await prisma.task.update({
      where: { id: t.id },
      data: done ? { status: "done", doneAt: new Date(), doneById: actor.id ?? null } : { status: "open", doneAt: null, doneById: null },
    });
  } else {
    const repeat = (isTaskRepeat(t.repeat) ? t.repeat : "daily") as TaskRepeat;
    const until = t.repeatUntil ? t.repeatUntil.toISOString().slice(0, 10) : null;
    if (!KEY.test(occurrence) || !fallsOn(istDateKey(t.dueAt), repeat, until, occurrence)) return { ok: false, error: "That task isn't due that day" };
    if (done) {
      await prisma.taskDone.upsert({
        where: { taskId_occurrence: { taskId: t.id, occurrence } },
        create: { taskId: t.id, occurrence, doneById: actor.id ?? null },
        update: {},
      });
    } else {
      await prisma.taskDone.deleteMany({ where: { taskId: t.id, occurrence } });
    }
  }
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: done ? "task.done" : "task.undone",
    entityType: "task",
    entityId: t.id,
    field: t.repeat === "none" ? null : occurrence,
    newValue: t.title,
  });
  return { ok: true };
}

/// Delete a task (every occurrence). Whoever set it, or an admin.
export async function deleteTask(actor: SessionUser, taskId: string): Promise<Result> {
  const t = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null }, select: { id: true, title: true, assigneeId: true, createdById: true } });
  if (!t) return { ok: false, error: "Task not found" };
  const mine = actor.id === t.createdById || (t.createdById === null && actor.id === t.assigneeId);
  if (!mine && !isAdmin(actor)) return { ok: false, error: "Only whoever set this task can delete it" };
  await prisma.task.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
  await writeAudit({ actorId: actor.id, actorEmail: actor.email, action: "task.delete", entityType: "task", entityId: t.id, oldValue: t.title });
  return { ok: true, info: "Task deleted" };
}

// ── Blocked time ───────────────────────────────────────────────────────────────

export async function createBlock(
  actor: SessionUser,
  input: { userId?: string; startAt: string; endAt: string; kind: string; note?: string },
): Promise<Result> {
  if (!actor.id) return { ok: false, error: "Not signed in" };
  const userId = input.userId || actor.id;
  if (userId !== actor.id && !isAdmin(actor)) return { ok: false, error: "You can block time only on your own calendar" };
  if (!isBlockKind(input.kind)) return { ok: false, error: "Pick what the time is for" };
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return { ok: false, error: "Pick a start and an end" };
  if (!(endAt > startAt)) return { ok: false, error: "The end must be after the start" };
  if (endAt.getTime() - startAt.getTime() > MAX_BLOCK_DAYS * DAY_MS) {
    return { ok: false, error: `Longer than ${MAX_BLOCK_DAYS} days is leave — request it under Appointments → Leave` };
  }
  const note = input.note?.trim() || null;
  const label = BLOCK_KIND_LABELS[input.kind];

  const resource = await prisma.resource.findUnique({ where: { userId }, select: { id: true } });
  // A doctor's or staff member's block is time off too, so booking treats it like leave.
  const off = resource
    ? await prisma.resourceTimeOff.create({
        data: {
          resourceId: resource.id,
          startAt,
          endAt,
          kind: input.kind,
          reason: note ? `${label} — ${note}` : label,
          status: "approved",
          source: "calendar",
          requestedById: actor.id,
          decidedById: actor.id,
          decidedAt: new Date(),
          createdById: actor.id,
        },
        select: { id: true },
      })
    : null;
  const block = await prisma.timeBlock.create({
    data: { userId, startAt, endAt, kind: input.kind, note, timeOffId: off?.id ?? null, createdById: actor.id },
    select: { id: true },
  });
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "calendar.block",
    entityType: "user",
    entityId: userId,
    newValue: `${label}: ${startAt.toISOString()} – ${endAt.toISOString()}`,
    reason: note,
    meta: { blockId: block.id, timeOffId: off?.id ?? null },
  });
  if (!resource || !off) return { ok: true, info: "Time blocked" };
  const d = await detectConflicts({ resourceId: resource.id, from: startAt, to: endAt, cause: "leave", timeOffId: off.id, actor });
  const n = d.appointmentIds.length;
  return {
    ok: true,
    info: n
      ? `Time blocked. ${n} appointment(s) already booked in it need rebooking — see Appointments → Needs rebooking.`
      : "Time blocked — no patient can be booked with you then.",
  };
}

export async function removeBlock(actor: SessionUser, blockId: string): Promise<Result> {
  const b = await prisma.timeBlock.findFirst({ where: { id: blockId, removedAt: null } });
  if (!b) return { ok: false, error: "Already removed" };
  if (b.userId !== actor.id && !isAdmin(actor)) return { ok: false, error: "Only the person whose time it is can remove it" };
  await prisma.timeBlock.update({ where: { id: b.id }, data: { removedAt: new Date() } });
  let closed = 0;
  if (b.timeOffId) {
    await prisma.resourceTimeOff.updateMany({
      where: { id: b.timeOffId, status: "approved" },
      data: { status: "cancelled", decidedById: actor.id ?? null, decidedAt: new Date() },
    });
    closed = await recheckOpenCases({ timeOffId: b.timeOffId });
  }
  await writeAudit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "calendar.unblock",
    entityType: "user",
    entityId: b.userId,
    oldValue: `${isBlockKind(b.kind) ? BLOCK_KIND_LABELS[b.kind] : b.kind}: ${b.startAt.toISOString()} – ${b.endAt.toISOString()}`,
    meta: { blockId: b.id, timeOffId: b.timeOffId },
  });
  return { ok: true, info: closed ? `Removed — ${closed} rebooking case(s) closed` : "Removed" };
}
