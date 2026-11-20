"use client";

// The personal calendar (/calendar): one person's appointments, lead follow-ups, tasks and
// blocked time, in four views — a list (agenda), a day and a week drawn vertically (hours
// down the side), and a timeline drawn horizontally (hours across, a row per day), the
// layouts Zenoti offers. Drag across empty time to block it; click empty time to add a
// task there. State is in the URL (view, date, user), like the appointments desk.
import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { addTask, blockTime, removeTask, tickTask, unblockTime } from "@/app/(dashboard)/calendar/actions";
import { closeLeadFollowUp } from "@/app/(dashboard)/leads/followUpActions";
import { TASK_REPEATS, TASK_REPEAT_LABELS } from "@/lib/calendar/recurrence";
import { BLOCK_KINDS, BLOCK_KIND_LABELS, CAL_VIEWS, type CalBlock, type CalendarData, type CalTask, type CalView } from "@/lib/calendar/types";
import { STATUS_LABEL, STATUS_TONE, addDays, fmtDay, fmtLongDay, fmtRange, fmtTime, hhmm, istIso, istMin, keyOf } from "@/components/scheduling/desk/ui";

type Opt = { id: string; label: string };
type Result = { ok: boolean; error?: string; info?: string };

/// One thing on the calendar, flattened for drawing. Timed items have start/end minutes;
/// all-day tasks sit in the strip above the grid.
type Item = {
  key: string;
  dateKey: string;
  allDay: boolean;
  startMin: number;
  endMin: number;
  tone: string;
  title: string;
  sub: string;
  done?: boolean;
  hatch?: boolean;
  ref:
    | { kind: "appointment"; href: string }
    | { kind: "followup"; id: string; leadId: string; leadName: string; title: string; at: string }
    | { kind: "task"; task: CalTask }
    | { kind: "block"; block: CalBlock };
};

const TASK_MIN = 30; // a timed task is drawn half an hour tall
const SNAP = 15;

function taskTone(t: CalTask): string {
  if (t.done) return "aqua";
  if (t.overdue) return "fushia";
  return "klein";
}

/// Split anything spanning midnight into one piece per IST day.
function perDay(startIso: string, endIso: string): { dateKey: string; startMin: number; endMin: number }[] {
  const out: { dateKey: string; startMin: number; endMin: number }[] = [];
  let key = keyOf(startIso);
  const lastKey = keyOf(new Date(new Date(endIso).getTime() - 1).toISOString());
  for (let guard = 0; key <= lastKey && guard < 14; guard++, key = addDays(key, 1)) {
    const dayStart = istIso(key, 0);
    const dayEnd = istIso(key, 1440);
    const s = startIso > dayStart ? istMin(startIso) : 0;
    const e = endIso < dayEnd ? istMin(endIso) || 1440 : 1440;
    if (e > s) out.push({ dateKey: key, startMin: s, endMin: e });
  }
  return out;
}

function buildItems(data: CalendarData): Item[] {
  const items: Item[] = [];
  for (const a of data.appointments) {
    for (const p of perDay(a.startAt, a.endAt)) {
      items.push({
        key: `a${a.id}${p.dateKey}`,
        ...p,
        allDay: false,
        tone: a.title === "Booked" ? "neutral" : (STATUS_TONE[a.status] ?? "blue"),
        title: a.title,
        sub: [a.detail, STATUS_LABEL[a.status]].filter(Boolean).join(" · "),
        ref: { kind: "appointment", href: a.href },
      });
    }
  }
  for (const f of data.followUps) {
    const s = istMin(f.at);
    items.push({
      key: `f${f.id}`,
      dateKey: keyOf(f.at),
      allDay: false,
      startMin: s,
      endMin: Math.min(s + TASK_MIN, 1440),
      tone: f.overdue ? "fushia" : "tangerine",
      title: `Follow up: ${f.leadName}`,
      sub: f.title,
      ref: { kind: "followup", id: f.id, leadId: f.leadId, leadName: f.leadName, title: f.title, at: f.at },
    });
  }
  for (const t of data.tasks) {
    const s = t.allDay ? 0 : istMin(t.at);
    items.push({
      key: `t${t.id}${t.occurrence}`,
      dateKey: t.occurrence,
      allDay: t.allDay,
      startMin: s,
      endMin: t.allDay ? 1440 : Math.min(s + TASK_MIN, 1440),
      tone: taskTone(t),
      title: t.title,
      sub: [t.assignedBy ? `from ${t.assignedBy}` : null, t.repeat !== "none" ? TASK_REPEAT_LABELS[t.repeat as keyof typeof TASK_REPEAT_LABELS] : null]
        .filter(Boolean)
        .join(" · "),
      done: t.done,
      ref: { kind: "task", task: t },
    });
  }
  for (const b of data.blocks) {
    for (const p of perDay(b.startAt, b.endAt)) {
      items.push({
        key: `b${b.id}${p.dateKey}`,
        ...p,
        allDay: p.startMin === 0 && p.endMin === 1440,
        tone: "neutral",
        title: b.label,
        sub: b.note ?? "",
        hatch: true,
        ref: { kind: "block", block: b },
      });
    }
  }
  return items.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.startMin - b.startMin);
}

/// Side-by-side lanes for overlapping items in one day.
function lanes(items: Item[]): Map<string, { lane: number; of: number }> {
  const out = new Map<string, { lane: number; of: number }>();
  let cluster: Item[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    const placed: [string, number][] = [];
    for (const it of cluster) {
      let l = ends.findIndex((e) => e <= it.startMin);
      if (l === -1) {
        l = ends.length;
        ends.push(it.endMin);
      } else ends[l] = it.endMin;
      placed.push([it.key, l]);
    }
    for (const [k, l] of placed) out.set(k, { lane: l, of: ends.length });
    cluster = [];
  };
  for (const it of [...items].sort((a, b) => a.startMin - b.startMin)) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmmInput = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const toMin = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};

// ── Shell ──────────────────────────────────────────────────────────────────────

export function PersonalCalendar({
  data,
  view,
  date,
  today,
  nowIso,
  people,
  assignees,
  meId,
  canBlockHere,
}: {
  data: CalendarData;
  view: CalView;
  date: string;
  today: string;
  nowIso: string;
  /// Colleagues whose calendar the viewer may open (empty = own only).
  people: Opt[];
  assignees: Opt[];
  meId: string;
  canBlockHere: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<NewForm | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [open, setOpen] = useState<Item | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const items = useMemo(() => buildItems(data), [data]);
  const days = useMemo(() => {
    const out: string[] = [];
    for (let k = data.fromKey; k <= data.toKey; k = addDays(k, 1)) out.push(k);
    return out;
  }, [data.fromKey, data.toKey]);

  function go(patch: { view?: string; date?: string; user?: string }) {
    const sp = new URLSearchParams();
    const next = { view, date, user: data.owner.isSelf ? "" : data.owner.id, ...patch };
    if (next.view && next.view !== "week") sp.set("view", next.view);
    if (next.date && next.date !== today) sp.set("date", next.date);
    if (next.user && next.user !== meId) sp.set("user", next.user);
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const act = (fn: () => Promise<Result>, after?: () => void) =>
    startTransition(async () => {
      const res = await fn();
      setFlash({ ok: res.ok, text: res.ok ? (res.info ?? "Saved") : (res.error ?? "Something went wrong") });
      if (res.ok) {
        after?.();
        router.refresh();
      }
    });

  const newItem = (f: NewForm) => {
    setFormKey((k) => k + 1);
    setForm(f);
  };

  const step = view === "day" ? 1 : 7;
  const heading = view === "day" ? fmtLongDay(date) : `${fmtDay(data.fromKey)} – ${fmtDay(data.toKey)}`;
  const nowMin = istMin(nowIso);
  const defaultTaskTime = date === today ? Math.min(Math.ceil((nowMin + 1) / 30) * 30, 23 * 60) : 10 * 60;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="cara-card space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button className="cara-btn" onClick={() => go({ date: addDays(date, -step) })} aria-label="Previous">‹</button>
          <button className="cara-btn" onClick={() => go({ date: addDays(date, step) })} aria-label="Next">›</button>
          <button className="cara-btn" onClick={() => go({ date: today })}>Today</button>
          <input type="date" className="cara-input w-auto!" value={date} onChange={(e) => e.target.value && go({ date: e.target.value })} aria-label="Date" />
          <div className="ml-1 text-[15px] font-semibold text-cara-ink">{heading}</div>
          <div className="flex-1" />
          <button className="cara-btn cara-btn-primary" onClick={() => newItem({ tab: "task", dateKey: date, startMin: defaultTaskTime, endMin: defaultTaskTime + 60 })}>
            + Task
          </button>
          {canBlockHere && (
            <button className="cara-btn" onClick={() => newItem({ tab: "block", dateKey: date, startMin: 13 * 60, endMin: 14 * 60 })}>
              + Block time
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {CAL_VIEWS.map((v) => (
            <button key={v.key} className={`cara-chip ${view === v.key ? "on" : ""}`} onClick={() => go({ view: v.key })}>
              {v.label}
            </button>
          ))}
          <div className="flex-1" />
          {people.length > 0 && (
            <select className="cara-select w-auto! max-w-[16rem]!" value={data.owner.id} onChange={(e) => go({ user: e.target.value })} aria-label="Whose calendar">
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === meId ? `${p.label} (me)` : p.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {!data.owner.isSelf && (
          <div className="cara-notice is-info text-[12.5px]">
            You&rsquo;re looking at <b>{data.owner.name}</b>&rsquo;s calendar. You can set them a task; only they can block their own time.
          </div>
        )}
        {flash && (
          <div className={`cara-notice ${flash.ok ? "is-info" : "is-warn"} flex items-center justify-between text-[12.5px]`}>
            <span>{flash.text}</span>
            <button className="text-cara-muted" onClick={() => setFlash(null)} aria-label="Dismiss">×</button>
          </div>
        )}
      </div>

      <Attention data={data} pending={pending} act={act} />

      {view === "list" && <ListView days={days} items={items} today={today} onOpen={setOpen} />}
      {(view === "day" || view === "week") && (
        <VerticalView
          days={days}
          items={items}
          today={today}
          nowMin={nowMin}
          canBlock={canBlockHere}
          onOpen={setOpen}
          onNew={newItem}
        />
      )}
      {view === "timeline" && (
        <TimelineView days={days} items={items} today={today} nowMin={nowMin} canBlock={canBlockHere} onOpen={setOpen} onNew={newItem} />
      )}

      <Legend showAppointments={data.owner.hasResource} showFollowUps={data.owner.hasRep} canBlock={canBlockHere} />

      {form && (
        <NewItemDialog
          key={formKey}
          initial={form}
          canBlock={canBlockHere}
          owner={data.owner}
          assignees={assignees}
          pending={pending}
          onClose={() => setForm(null)}
          onTask={(input) => act(() => addTask(input), () => setForm(null))}
          onBlock={(input) => act(() => blockTime({ ...input, userId: data.owner.id }), () => setForm(null))}
        />
      )}
      {open && <ItemDialog item={open} pending={pending} act={act} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── Overdue and assigned-by-me ─────────────────────────────────────────────────

function Attention({ data, pending, act }: { data: CalendarData; pending: boolean; act: (fn: () => Promise<Result>, after?: () => void) => void }) {
  const showByMe = data.owner.isSelf && data.assignedByMe.length > 0;
  if (!data.overdueTasks.length && !data.overdueFollowUps && !showByMe) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {(data.overdueTasks.length > 0 || data.overdueFollowUps > 0) && (
        <div className="cara-card space-y-2 p-3">
          <div className="text-[13px] font-semibold txt-bad">Overdue</div>
          {data.overdueFollowUps > 0 && (
            <div className="text-[12.5px]">
              <b>{data.overdueFollowUps}</b> lead follow-up{data.overdueFollowUps === 1 ? "" : "s"} past due
              {data.owner.isSelf && (
                <>
                  {" "}— <Link href="/my-numbers" className="tone-link">see them</Link>
                </>
              )}
            </div>
          )}
          <ul className="space-y-1">
            {data.overdueTasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={pending || !t.canTick}
                  onChange={() => act(() => tickTask(t.id, t.occurrence, true))}
                  aria-label={`Mark ${t.title} done`}
                />
                <span className="font-medium text-cara-ink">{t.title}</span>
                <span className="text-cara-muted">
                  due {fmtDay(t.occurrence)}
                  {t.allDay ? "" : ` ${fmtTime(t.at)}`}
                  {t.assignedBy ? ` · from ${t.assignedBy}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {showByMe && (
        <div className="cara-card space-y-2 p-3">
          <div className="text-[13px] font-semibold text-cara-ink">Tasks I&rsquo;ve set for others</div>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {data.assignedByMe.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[12.5px]">
                <span className={`tag tag-${t.overdue ? "fushia" : "klein"}`}>{t.assignedTo}</span>
                <span className="font-medium text-cara-ink">{t.title}</span>
                <span className="text-cara-muted">
                  {t.repeat !== "none" ? TASK_REPEAT_LABELS[t.repeat as keyof typeof TASK_REPEAT_LABELS] : `due ${fmtDay(t.occurrence)}${t.allDay ? "" : ` ${fmtTime(t.at)}`}`}
                </span>
                <div className="flex-1" />
                <button className="text-[12px] text-cara-muted hover:underline" disabled={pending} onClick={() => act(() => removeTask(t.id))}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── List ───────────────────────────────────────────────────────────────────────

function ListView({ days, items, today, onOpen }: { days: string[]; items: Item[]; today: string; onOpen: (i: Item) => void }) {
  return (
    <div className="cara-card divide-y divide-[var(--cara-rule)]">
      {days.map((d) => {
        const list = items.filter((i) => i.dateKey === d).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMin - b.startMin);
        return (
          <div key={d} className="flex gap-4 px-4 py-3">
            <div className={`w-28 shrink-0 text-[13px] font-semibold ${d === today ? "text-[var(--accent,#3358E8)]" : "text-cara-ink"}`}>
              {fmtDay(d)}
              {d === today && <div className="text-[11px] font-normal text-cara-muted">Today</div>}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              {list.length === 0 && <div className="text-[12.5px] text-cara-faint">Nothing scheduled</div>}
              {list.map((i) => (
                <button key={i.key} className="flex w-full items-center gap-3 rounded px-1 py-0.5 text-left hover:bg-[var(--cara-surface-2)]" onClick={() => onOpen(i)}>
                  <span className="w-32 shrink-0 text-[12px] text-cara-muted">
                    {i.allDay ? "All day" : `${hhmm(i.startMin)}${i.ref.kind === "appointment" || i.ref.kind === "block" ? ` – ${hhmm(i.endMin)}` : ""}`}
                  </span>
                  <span className={`tag tag-${i.tone} shrink-0`}>{KIND_LABEL[i.ref.kind]}</span>
                  <span className={`truncate text-[13px] font-medium text-cara-ink ${i.done ? "line-through opacity-60" : ""}`}>{i.title}</span>
                  {i.sub && <span className="truncate text-[12px] text-cara-muted">{i.sub}</span>}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const KIND_LABEL: Record<Item["ref"]["kind"], string> = {
  appointment: "Appointment",
  followup: "Follow-up",
  task: "Task",
  block: "Blocked",
};

// ── Drag to block ──────────────────────────────────────────────────────────────

type NewForm = { tab: "task" | "block"; dateKey: string; startMin: number; endMin: number };
type Drag = { dateKey: string; a: number; b: number; moved: boolean };

/// Pointer handling shared by the vertical and horizontal grids: press on empty time,
/// drag along the time axis, release. A drag of at least one snap blocks that time; a
/// plain click offers a task at that time.
function useDragToBlock(opts: {
  startMin: number;
  pxPerMin: number;
  axis: "x" | "y";
  canBlock: boolean;
  onNew: (f: NewForm) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const minuteAt = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = opts.axis === "y" ? e.clientY - r.top : e.clientX - r.left;
    const m = opts.startMin + px / opts.pxPerMin;
    return Math.max(0, Math.min(1440, Math.round(m / SNAP) * SNAP));
  };
  const update = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };
  const handlers = (dateKey: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !(e.target as HTMLElement).dataset.grid) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const m = minuteAt(e);
      const floor = Math.floor(m / SNAP) * SNAP;
      update({ dateKey, a: floor, b: floor, moved: false });
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d || d.dateKey !== dateKey) return;
      const m = minuteAt(e);
      if (m !== d.b) update({ ...d, b: m, moved: d.moved || Math.abs(m - d.a) >= SNAP });
    },
    onPointerUp: () => {
      const d = dragRef.current;
      update(null);
      if (!d || d.dateKey !== dateKey) return;
      const lo = Math.min(d.a, d.b);
      const hi = Math.max(d.a, d.b);
      if (d.moved && opts.canBlock && hi - lo >= SNAP) opts.onNew({ tab: "block", dateKey, startMin: lo, endMin: hi });
      else opts.onNew({ tab: "task", dateKey, startMin: d.a, endMin: d.a + 60 });
    },
    onPointerCancel: () => update(null),
  });
  const ghost = (dateKey: string) => {
    if (!drag || drag.dateKey !== dateKey || !drag.moved) return null;
    return { lo: Math.min(drag.a, drag.b), hi: Math.max(drag.a, drag.b) };
  };
  return { handlers, ghost };
}

/// The hours a grid shows: 8 AM to 9 PM, widened to fit whatever is on it.
function gridSpan(items: Item[]): [number, number] {
  const timed = items.filter((i) => !i.allDay);
  const lo = Math.min(8 * 60, ...timed.map((i) => i.startMin));
  const hi = Math.max(21 * 60, ...timed.map((i) => i.endMin));
  return [Math.floor(lo / 60) * 60, Math.min(1440, Math.ceil(hi / 60) * 60)];
}

function ItemBlock({ item, style, onOpen }: { item: Item; style: React.CSSProperties; onOpen: (i: Item) => void }) {
  return (
    <button
      className={`tag-${item.tone} absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm ${item.done ? "opacity-60" : ""}`}
      style={{
        ...style,
        background: item.hatch
          ? "repeating-linear-gradient(135deg, var(--tag-fill) 0 6px, var(--cara-surface) 6px 12px)"
          : "var(--tag-fill)",
        borderColor: "var(--tag-line)",
        color: "var(--tag-ink)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => onOpen(item)}
      title={`${item.title}${item.sub ? ` · ${item.sub}` : ""}`}
    >
      <div className={`truncate font-semibold ${item.done ? "line-through" : ""}`}>{item.title}</div>
      {item.sub && <div className="truncate opacity-85">{item.sub}</div>}
    </button>
  );
}

function AllDayStrip({ items, onOpen }: { items: Item[]; onOpen: (i: Item) => void }) {
  return (
    <div className="min-h-7 space-y-0.5 border-b border-cara-rule p-0.5">
      {items.map((i) => (
        <button
          key={i.key}
          className={`tag tag-${i.tone} block w-full truncate text-left ${i.done ? "line-through opacity-60" : ""}`}
          style={i.hatch ? { background: "repeating-linear-gradient(135deg, var(--tag-fill) 0 6px, var(--cara-surface) 6px 12px)" } : undefined}
          onClick={() => onOpen(i)}
          title={i.title}
        >
          {i.title}
        </button>
      ))}
    </div>
  );
}

// ── Day / week (vertical) ──────────────────────────────────────────────────────

const VPX = 1; // px per minute

function VerticalView({
  days,
  items,
  today,
  nowMin,
  canBlock,
  onOpen,
  onNew,
}: {
  days: string[];
  items: Item[];
  today: string;
  nowMin: number;
  canBlock: boolean;
  onOpen: (i: Item) => void;
  onNew: (f: NewForm) => void;
}) {
  const [startMin, endMin] = gridSpan(items);
  const height = (endMin - startMin) * VPX;
  const hours: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hours.push(m);
  const { handlers, ghost } = useDragToBlock({ startMin, pxPerMin: VPX, axis: "y", canBlock, onNew });
  const wide = days.length > 1;

  return (
    <div className="cara-card overflow-x-auto">
      <div className={`flex ${wide ? "min-w-[900px]" : ""}`}>
        <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-cara-rule bg-[var(--cara-surface)]">
          <div className="h-9 border-b border-cara-rule" />
          <div className="min-h-7 border-b border-cara-rule px-1 py-1 text-right text-[10px] text-cara-muted">all day</div>
          <div className="relative" style={{ height }}>
            {hours.map((m) => (
              <div key={m} className="absolute right-1.5 -translate-y-1/2 text-[10.5px] text-cara-muted" style={{ top: (m - startMin) * VPX }}>
                {m === startMin ? "" : hhmm(m)}
              </div>
            ))}
          </div>
        </div>
        {days.map((d) => {
          const dayItems = items.filter((i) => i.dateKey === d);
          const timed = dayItems.filter((i) => !i.allDay);
          const laneOf = lanes(timed);
          const g = ghost(d);
          return (
            <div key={d} className="min-w-0 flex-1 border-r border-cara-rule">
              <div className={`h-9 border-b border-cara-rule px-2 py-2 text-[12.5px] font-semibold ${d === today ? "text-[var(--accent,#3358E8)]" : "text-cara-ink"}`}>
                {fmtDay(d)}
              </div>
              <AllDayStrip items={dayItems.filter((i) => i.allDay)} onOpen={onOpen} />
              <div className="relative cursor-crosshair touch-none select-none" style={{ height }} data-grid="1" {...handlers(d)}>
                {hours.map((m) => (
                  <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-[var(--cara-rule)] opacity-60" style={{ top: (m - startMin) * VPX }} />
                ))}
                {timed.map((i) => {
                  const l = laneOf.get(i.key) ?? { lane: 0, of: 1 };
                  return (
                    <ItemBlock
                      key={i.key}
                      item={i}
                      onOpen={onOpen}
                      style={{
                        top: (i.startMin - startMin) * VPX + 1,
                        height: Math.max((i.endMin - i.startMin) * VPX - 2, 16),
                        left: `calc(${(l.lane / l.of) * 100}% + 2px)`,
                        width: `calc(${100 / l.of}% - 4px)`,
                      }}
                    />
                  );
                })}
                {g && (
                  <div
                    className="pointer-events-none absolute inset-x-1 rounded-md border-2 border-dashed border-[var(--cara-ink)] bg-[var(--cara-surface-2)] px-1.5 py-0.5 text-[11px] font-medium opacity-80"
                    style={{ top: (g.lo - startMin) * VPX, height: Math.max((g.hi - g.lo) * VPX, 4) }}
                  >
                    Block {hhmm(g.lo)} – {hhmm(g.hi)}
                  </div>
                )}
                {d === today && nowMin >= startMin && nowMin <= endMin && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-[#e2453b]" style={{ top: (nowMin - startMin) * VPX }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 text-[11px] text-cara-muted">
        {canBlock ? "Drag down across empty time to block it · click empty time to add a task there" : "Click empty time to add a task there"}
      </div>
    </div>
  );
}

// ── Timeline (horizontal) ──────────────────────────────────────────────────────

const HPX = 1.4; // px per minute

function TimelineView({
  days,
  items,
  today,
  nowMin,
  canBlock,
  onOpen,
  onNew,
}: {
  days: string[];
  items: Item[];
  today: string;
  nowMin: number;
  canBlock: boolean;
  onOpen: (i: Item) => void;
  onNew: (f: NewForm) => void;
}) {
  const [startMin, endMin] = gridSpan(items);
  const width = (endMin - startMin) * HPX;
  const hours: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hours.push(m);
  const { handlers, ghost } = useDragToBlock({ startMin, pxPerMin: HPX, axis: "x", canBlock, onNew });
  const ROW = 30;

  return (
    <div className="cara-card overflow-x-auto">
      <div className="min-w-max">
        <div className="flex border-b border-cara-rule">
          <div className="sticky left-0 z-20 w-36 shrink-0 border-r border-cara-rule bg-[var(--cara-surface)]" />
          <div className="relative h-7" style={{ width }}>
            {hours.map((m) => (
              <div key={m} className="absolute top-1.5 text-[10.5px] text-cara-muted" style={{ left: (m - startMin) * HPX + 3 }}>
                {hhmm(m)}
              </div>
            ))}
          </div>
        </div>
        {days.map((d) => {
          const dayItems = items.filter((i) => i.dateKey === d);
          const allDay = dayItems.filter((i) => i.allDay);
          const timed = dayItems.filter((i) => !i.allDay);
          const laneOf = lanes(timed);
          const rows = Math.max(1, ...timed.map((i) => laneOf.get(i.key)?.of ?? 1));
          const g = ghost(d);
          return (
            <div key={d} className="flex border-b border-cara-rule">
              <div className="sticky left-0 z-20 w-36 shrink-0 space-y-0.5 border-r border-cara-rule bg-[var(--cara-surface)] px-2 py-1.5">
                <div className={`text-[12.5px] font-semibold ${d === today ? "text-[var(--accent,#3358E8)]" : "text-cara-ink"}`}>{fmtDay(d)}</div>
                {allDay.map((i) => (
                  <button
                    key={i.key}
                    className={`tag tag-${i.tone} block w-full truncate text-left text-[10.5px] ${i.done ? "line-through opacity-60" : ""}`}
                    onClick={() => onOpen(i)}
                    title={i.title}
                  >
                    {i.title}
                  </button>
                ))}
              </div>
              <div className="relative cursor-crosshair touch-none select-none" style={{ width, height: rows * ROW + 8 }} data-grid="1" {...handlers(d)}>
                {hours.map((m) => (
                  <div key={m} className="pointer-events-none absolute inset-y-0 border-l border-[var(--cara-rule)] opacity-60" style={{ left: (m - startMin) * HPX }} />
                ))}
                {timed.map((i) => {
                  const l = laneOf.get(i.key) ?? { lane: 0, of: 1 };
                  return (
                    <ItemBlock
                      key={i.key}
                      item={i}
                      onOpen={onOpen}
                      style={{ left: (i.startMin - startMin) * HPX + 1, width: Math.max((i.endMin - i.startMin) * HPX - 2, 24), top: 4 + l.lane * ROW, height: ROW - 3 }}
                    />
                  );
                })}
                {g && (
                  <div
                    className="pointer-events-none absolute inset-y-1 rounded-md border-2 border-dashed border-[var(--cara-ink)] bg-[var(--cara-surface-2)] px-1.5 py-0.5 text-[11px] font-medium opacity-80"
                    style={{ left: (g.lo - startMin) * HPX, width: Math.max((g.hi - g.lo) * HPX, 4) }}
                  >
                    {hhmm(g.lo)} – {hhmm(g.hi)}
                  </div>
                )}
                {d === today && nowMin >= startMin && nowMin <= endMin && (
                  <div className="pointer-events-none absolute inset-y-0 z-10 border-l-2 border-[#e2453b]" style={{ left: (nowMin - startMin) * HPX }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 text-[11px] text-cara-muted">
        {canBlock ? "Drag across empty time to block it · click empty time to add a task there" : "Click empty time to add a task there"}
      </div>
    </div>
  );
}

function Legend({ showAppointments, showFollowUps, canBlock }: { showAppointments: boolean; showFollowUps: boolean; canBlock: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-cara-rule bg-[var(--cara-surface)] px-4 py-2 text-[12px] text-cara-muted">
      {showAppointments && <span><span className="tag tag-blue">Appointment</span> coloured by status</span>}
      {showFollowUps && <span><span className="tag tag-tangerine">Follow-up</span> lead follow-ups you own</span>}
      <span><span className="tag tag-klein">Task</span></span>
      <span><span className="tag tag-aqua">Done</span></span>
      <span><span className="tag tag-fushia">Overdue</span></span>
      <span><span className="tag tag-neutral">Blocked</span>{canBlock && showAppointments ? " no patient can be booked with you then" : ""}</span>
    </div>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────────────

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-16" onClick={onClose} role="dialog" aria-modal aria-label={title}>
      <div className="w-full max-w-[28rem] space-y-4 rounded-xl bg-cara-page p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="cara-title">{title}</h2>
          <button className="cara-btn" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NewItemDialog({
  initial,
  canBlock,
  owner,
  assignees,
  pending,
  onClose,
  onTask,
  onBlock,
}: {
  initial: NewForm;
  canBlock: boolean;
  owner: CalendarData["owner"];
  assignees: Opt[];
  pending: boolean;
  onClose: () => void;
  onTask: (input: { assigneeId: string; title: string; notes: string; date: string; time: string; repeat: string; repeatUntil: string }) => void;
  onBlock: (input: { startAt: string; endAt: string; kind: string; note: string }) => void;
}) {
  const [tab, setTab] = useState<"task" | "block">(canBlock ? initial.tab : "task");
  const [task, setTask] = useState({
    assigneeId: owner.id,
    title: "",
    notes: "",
    date: initial.dateKey,
    timed: initial.tab === "task",
    time: hhmmInput(initial.startMin),
    repeat: "none",
    repeatUntil: "",
  });
  const endsNextDay = initial.endMin >= 1440;
  const [block, setBlock] = useState({
    kind: "break",
    note: "",
    allDay: initial.startMin === 0 && initial.endMin === 1440,
    startDate: initial.dateKey,
    start: hhmmInput(initial.startMin),
    endDate: endsNextDay ? addDays(initial.dateKey, 1) : initial.dateKey,
    end: hhmmInput(initial.endMin % 1440),
  });

  const submitBlock = () => {
    const startAt = block.allDay ? istIso(block.startDate, 0) : istIso(block.startDate, toMin(block.start));
    const endAt = block.allDay ? istIso(addDays(block.endDate, 1), 0) : istIso(block.endDate, toMin(block.end));
    onBlock({ startAt, endAt, kind: block.kind, note: block.note });
  };

  return (
    <Dialog title={tab === "task" ? "New task" : "Block time"} onClose={onClose}>
      {canBlock && (
        <div className="flex gap-2">
          <button className={`cara-chip ${tab === "task" ? "on" : ""}`} onClick={() => setTab("task")}>Task</button>
          <button className={`cara-chip ${tab === "block" ? "on" : ""}`} onClick={() => setTab("block")}>Block time</button>
        </div>
      )}

      {tab === "task" ? (
        <div className="space-y-3">
          <input className="cara-input" placeholder="What needs doing? *" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} autoFocus />
          <textarea className="cara-input min-h-16" placeholder="Notes (optional)" value={task.notes} onChange={(e) => setTask({ ...task, notes: e.target.value })} />
          <label className="block text-[12.5px] text-cara-muted">
            For
            <select className="cara-select mt-1" value={task.assigneeId} onChange={(e) => setTask({ ...task, assigneeId: e.target.value })}>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[12.5px] text-cara-muted">
              Due
              <input type="date" className="cara-input mt-1 w-auto!" value={task.date} onChange={(e) => setTask({ ...task, date: e.target.value })} />
            </label>
            {task.timed && (
              <input type="time" className="cara-input w-auto!" step={900} value={task.time} onChange={(e) => setTask({ ...task, time: e.target.value })} aria-label="Time" />
            )}
            <label className="flex items-center gap-1.5 pb-2 text-[12.5px]">
              <input type="checkbox" checked={!task.timed} onChange={(e) => setTask({ ...task, timed: !e.target.checked })} />
              Any time that day
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[12.5px] text-cara-muted">
              Repeats
              <select className="cara-select mt-1 w-auto!" value={task.repeat} onChange={(e) => setTask({ ...task, repeat: e.target.value })}>
                {TASK_REPEATS.map((r) => (
                  <option key={r} value={r}>{TASK_REPEAT_LABELS[r]}</option>
                ))}
              </select>
            </label>
            {task.repeat !== "none" && (
              <label className="text-[12.5px] text-cara-muted">
                Until (optional)
                <input type="date" className="cara-input mt-1 w-auto!" value={task.repeatUntil} min={task.date} onChange={(e) => setTask({ ...task, repeatUntil: e.target.value })} />
              </label>
            )}
          </div>
          <button
            className="cara-btn cara-btn-primary"
            disabled={pending || !task.title.trim() || !task.date}
            onClick={() =>
              onTask({
                assigneeId: task.assigneeId,
                title: task.title,
                notes: task.notes,
                date: task.date,
                time: task.timed ? task.time : "",
                repeat: task.repeat,
                repeatUntil: task.repeatUntil,
              })
            }
          >
            {task.assigneeId === owner.id && owner.isSelf ? "Add task" : "Set task"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {BLOCK_KINDS.map((k) => (
              <button key={k} className={`cara-chip ${block.kind === k ? "on" : ""}`} onClick={() => setBlock({ ...block, kind: k })}>
                {BLOCK_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" checked={block.allDay} onChange={(e) => setBlock({ ...block, allDay: e.target.checked })} />
            Whole day{block.allDay ? "s" : ""}
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[12.5px] text-cara-muted">
              From
              <input type="date" className="cara-input mt-1 w-auto!" value={block.startDate} onChange={(e) => setBlock({ ...block, startDate: e.target.value, endDate: e.target.value > block.endDate ? e.target.value : block.endDate })} />
            </label>
            {!block.allDay && <input type="time" className="cara-input w-auto!" step={900} value={block.start} onChange={(e) => setBlock({ ...block, start: e.target.value })} aria-label="Start time" />}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[12.5px] text-cara-muted">
              To
              <input type="date" className="cara-input mt-1 w-auto!" value={block.endDate} min={block.startDate} onChange={(e) => setBlock({ ...block, endDate: e.target.value })} />
            </label>
            {!block.allDay && <input type="time" className="cara-input w-auto!" step={900} value={block.end} onChange={(e) => setBlock({ ...block, end: e.target.value })} aria-label="End time" />}
          </div>
          <input className="cara-input" placeholder="Note (optional)" value={block.note} onChange={(e) => setBlock({ ...block, note: e.target.value })} />
          {owner.hasResource && (
            <div className="cara-notice is-info text-[12.5px]">
              No patient can be booked with you in this time. Anything already booked in it goes to Needs rebooking.
            </div>
          )}
          <button className="cara-btn cara-btn-primary" disabled={pending} onClick={submitBlock}>
            Block time
          </button>
        </div>
      )}
    </Dialog>
  );
}

function ItemDialog({
  item,
  pending,
  act,
  onClose,
}: {
  item: Item;
  pending: boolean;
  act: (fn: () => Promise<Result>, after?: () => void) => void;
  onClose: () => void;
}) {
  const r = item.ref;
  const when = item.allDay ? `${fmtLongDay(item.dateKey)} · all day` : `${fmtLongDay(item.dateKey)} · ${hhmm(item.startMin)}`;
  return (
    <Dialog title={KIND_LABEL[r.kind]} onClose={onClose}>
      <div className="space-y-1">
        <div className={`text-[15px] font-semibold text-cara-ink ${item.done ? "line-through opacity-60" : ""}`}>{item.title}</div>
        <div className="text-[12.5px] text-cara-muted">
          {r.kind === "block" ? fmtRange(r.block.startAt, r.block.endAt) + (keyOf(r.block.startAt) !== keyOf(r.block.endAt) ? ` (${fmtDay(keyOf(r.block.startAt))} → ${fmtDay(keyOf(new Date(new Date(r.block.endAt).getTime() - 1).toISOString()))})` : ` · ${fmtDay(item.dateKey)}`) : when}
        </div>
        {item.sub && <div className="text-[12.5px] text-cara-muted">{item.sub}</div>}
        {r.kind === "task" && r.task.notes && <p className="whitespace-pre-wrap pt-1 text-[13px]">{r.task.notes}</p>}
        {r.kind === "block" && r.block.blocksBookings && <div className="pt-1 text-[12.5px] text-cara-muted">No patient can be booked in this time.</div>}
      </div>

      <div className="flex flex-wrap gap-2">
        {r.kind === "appointment" && (
          <Link href={r.href} className="cara-btn cara-btn-primary">Open in Appointments</Link>
        )}
        {r.kind === "followup" && (
          <>
            <Link href={`/leads/${r.leadId}`} className="cara-btn cara-btn-primary">Open lead</Link>
            <button className="cara-btn" disabled={pending} onClick={() => act(() => closeLeadFollowUp({ leadId: r.leadId, stepId: r.id, status: "done" }), onClose)}>
              Mark done
            </button>
          </>
        )}
        {r.kind === "task" && (
          <>
            {r.task.canTick && (
              <button className="cara-btn cara-btn-primary" disabled={pending} onClick={() => act(() => tickTask(r.task.id, r.task.occurrence, !r.task.done), onClose)}>
                {r.task.done ? "Mark not done" : "Mark done"}
              </button>
            )}
            {r.task.canDelete && (
              <button
                className="cara-btn"
                disabled={pending}
                onClick={() => {
                  if (r.task.repeat !== "none" && !window.confirm("Delete this task and every repeat of it?")) return;
                  act(() => removeTask(r.task.id), onClose);
                }}
              >
                Delete{r.task.repeat !== "none" ? " (all repeats)" : ""}
              </button>
            )}
          </>
        )}
        {r.kind === "block" && r.block.canRemove && (
          <button className="cara-btn" disabled={pending} onClick={() => act(() => unblockTime(r.block.id), onClose)}>
            Remove block
          </button>
        )}
      </div>
    </Dialog>
  );
}
