"use client";

// The four ways of looking at the calendar (§2.2): a day as resource columns (the
// front-desk layout), a day as a list grouped by hour (Zenoti's list), a week, and the
// front-desk board (1.B — who's expected, waiting, with the doctor, done).
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setAppointmentStatus } from "@/app/(dashboard)/appointments/actions";
import { FlagGlyph, IconAlert, IconCheck } from "@/components/Icon";
import type { CalendarAppointment, ColumnResource, WeekRosterDay } from "./types";
import { STATUS_ACTION, STATUS_LABEL, STATUS_TONE, addDays, fmtDay, fmtRange, fmtTime, hhmm, istMin, keyOf } from "./ui";

function Flags({ a }: { a: CalendarAppointment }) {
  if (!a.flags.length) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      {a.flags.map((f) => (
        <span key={f.label} className={`tag-${f.tone}`} style={{ color: "var(--tag-line)" }} title={f.label}>
          <FlagGlyph icon={f.icon} size={13} />
        </span>
      ))}
    </span>
  );
}

/// §2.7 — intake form done? (a tick, or a warning glyph when it carried red flags)
function IntakeMark({ a }: { a: CalendarAppointment }) {
  if (!a.intake || a.intake.state === "none") return null;
  if (a.intake.state === "pending") return <span className="text-[11px] text-cara-faint" title="Intake form not done yet">form pending</span>;
  return a.intake.redFlags ? (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium txt-bad" title={`Intake complete — ${a.intake.redFlags} red flag(s)`}>
      <IconAlert size={12} /> intake
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium txt-good" title="Intake complete">
      <IconCheck size={12} /> intake
    </span>
  );
}

function StatusTag({ status }: { status: string }) {
  return <span className={`tag tag-${STATUS_TONE[status] ?? "ink"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

const doctorOf = (a: CalendarAppointment) => a.resources.find((r) => r.kind === "doctor")?.name ?? "—";

// ── Day · list (grouped by hour) ────────────────────────────────────────────

export function ListView({ appts, chain, onOpen }: { appts: CalendarAppointment[]; chain: boolean; onOpen: (id: string) => void }) {
  if (appts.length === 0) return <p className="cara-note p-6 text-center">No appointments.</p>;
  const groups = new Map<number, CalendarAppointment[]>();
  for (const a of appts) {
    const h = Math.floor(istMin(a.startAt) / 60);
    groups.set(h, [...(groups.get(h) ?? []), a]);
  }
  return (
    <div className="cara-card overflow-x-auto">
      <table className="cara-table">
        <thead>
          <tr>
            <th>Guest</th>
            <th>Time</th>
            <th>Consultant</th>
            <th>Service</th>
            {chain && <th>Branch</th>}
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([h, rows]) => [
            <tr key={`h${h}`} className="bg-[var(--cara-surface-2)]">
              <td colSpan={chain ? 7 : 6} className="text-[12px] font-semibold text-cara-muted">
                {hhmm(h * 60)} – {hhmm((h + 1) * 60)}
              </td>
            </tr>,
            ...rows.map((a) => (
              <tr key={a.id} className="cursor-pointer" onClick={() => onOpen(a.id)}>
                <td className="whitespace-nowrap">
                  <span className={a.visible ? "font-medium text-[var(--accent,#3358E8)]" : "text-cara-muted"}>{a.patientName ?? "Booked"}</span>{" "}
                  <Flags a={a} /> <IntakeMark a={a} />
                </td>
                <td className="whitespace-nowrap">{fmtRange(a.startAt, a.endAt)}</td>
                <td className="whitespace-nowrap">{doctorOf(a)}</td>
                <td>{a.typeName ?? "—"}</td>
                {chain && <td className="whitespace-nowrap">{a.branchName}</td>}
                <td>
                  <StatusTag status={a.status} />
                  {a.doctorOverbooked && <IconAlert className="ml-1 inline txt-warn" />}
                </td>
                <td className="text-right text-[12px] text-cara-muted">Open</td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}

// ── Day · resource columns ──────────────────────────────────────────────────

const PX = 1.2; // pixels per minute: 15 min = 18 px

/// Side-by-side lanes for overlapping appointments in one column (a double-booked
/// doctor shows both, not one hidden under the other).
function lanes(items: CalendarAppointment[]): Map<string, { lane: number; of: number }> {
  const sorted = [...items].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const out = new Map<string, { lane: number; of: number }>();
  let cluster: CalendarAppointment[] = [];
  let clusterEnd = "";
  const flush = () => {
    const laneEnds: string[] = [];
    const assigned: [string, number][] = [];
    for (const a of cluster) {
      let l = laneEnds.findIndex((end) => end <= a.startAt);
      if (l === -1) {
        l = laneEnds.length;
        laneEnds.push(a.endAt);
      } else laneEnds[l] = a.endAt;
      assigned.push([a.id, l]);
    }
    for (const [id, l] of assigned) out.set(id, { lane: l, of: laneEnds.length });
    cluster = [];
  };
  for (const a of sorted) {
    if (cluster.length && a.startAt >= clusterEnd) flush();
    cluster.push(a);
    if (cluster.length === 1 || a.endAt > clusterEnd) clusterEnd = a.endAt;
  }
  if (cluster.length) flush();
  return out;
}

export function ResourceView({
  dateKey,
  columns,
  appts,
  open,
  closures,
  nowMin,
  canBookHere,
  onOpen,
  onSlot,
}: {
  dateKey: string;
  columns: ColumnResource[];
  appts: CalendarAppointment[];
  open: { startMin: number; endMin: number }[];
  closures: { startMin: number; endMin: number; reason: string }[];
  nowMin: number | null;
  canBookHere: boolean;
  onOpen: (id: string) => void;
  onSlot: (column: ColumnResource, minute: number) => void;
}) {
  if (columns.length === 0) return <p className="cara-note p-6 text-center">No resources at this branch yet — add them in Scheduling setup.</p>;

  const apptMins = appts.flatMap((a) => [istMin(a.startAt), istMin(a.endAt) || 1440]);
  const startMin = Math.floor(Math.min(open[0]?.startMin ?? 9 * 60, ...apptMins, 9 * 60) / 60) * 60;
  const endMin = Math.ceil(Math.max(open[open.length - 1]?.endMin ?? 20 * 60, ...apptMins, 18 * 60) / 60) * 60;
  const height = (endMin - startMin) * PX;
  const hours: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hours.push(m);

  return (
    <div className="cara-card overflow-x-auto">
      <div className="flex min-w-max">
        {/* Time gutter */}
        <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-cara-rule bg-[var(--cara-surface)]">
          <div className="h-16 border-b border-cara-rule" />
          <div className="relative" style={{ height }}>
            {hours.map((m) => (
              <div key={m} className="absolute right-1.5 -translate-y-1/2 text-[10.5px] text-cara-muted" style={{ top: (m - startMin) * PX }}>
                {m === startMin ? "" : hhmm(m)}
              </div>
            ))}
          </div>
        </div>

        {columns.map((c) => {
          const mine = appts.filter((a) => a.resources.some((r) => r.id === c.id));
          const laneOf = lanes(mine);
          const working = c.offToday ? [] : c.windows;
          return (
            <div key={c.id} className="w-44 shrink-0 border-r border-cara-rule">
              <div className="h-16 space-y-0.5 overflow-hidden border-b border-cara-rule px-2 py-1.5">
                <div className="truncate text-[12.5px] font-semibold text-cara-ink" title={c.name}>{c.name}</div>
                <div className="truncate text-[10.5px] text-cara-muted">
                  {c.kind === "staff" ? (c.subtype ?? "OT team") : c.kind === "doctor" ? "Doctor" : (c.subtype ?? c.kind)}
                  {c.windows.length > 0 && !c.offToday && c.rostered && ` · ${c.windows.map((w) => `${hhmm(w.startMin)}–${hhmm(w.endMin)}`).join(", ")}`}
                </div>
                {c.offToday && <div className="truncate text-[10.5px] font-medium txt-bad">Off: {c.offToday}</div>}
                {!c.offToday && c.elsewhere.length > 0 && (
                  <div className="truncate text-[10.5px] font-medium txt-warn" title={c.elsewhere.map((e) => `${e.branchName} ${hhmm(e.startMin)}–${hhmm(e.endMin)}`).join(", ")}>
                    at {c.elsewhere.map((e) => `${e.branchName} ${hhmm(e.startMin)}–${hhmm(e.endMin)}`).join(", ")}
                  </div>
                )}
              </div>
              <div
                className={`relative bg-[repeating-linear-gradient(135deg,var(--cara-surface-2)_0_6px,transparent_6px_12px)] ${canBookHere ? "cursor-copy" : ""}`}
                style={{ height }}
                onClick={(e) => {
                  // Only open (working) time books — the hatch is "not working here".
                  if (!canBookHere || !(e.target as HTMLElement).dataset.slot) return;
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                  const minute = startMin + Math.floor(y / PX / 15) * 15;
                  onSlot(c, minute);
                }}
              >
                {/* Available time is drawn plain; the hatch behind it is "not working". */}
                {working.map((w, i) => (
                  <div key={i} data-slot="1" className="absolute inset-x-0 bg-[var(--cara-surface)]" style={{ top: (w.startMin - startMin) * PX, height: (w.endMin - w.startMin) * PX }} />
                ))}
                {closures.map((cl, i) => (
                  <div
                    key={`c${i}`}
                    className="pointer-events-none absolute inset-x-0 bg-[repeating-linear-gradient(45deg,rgba(239,91,60,.12)_0_6px,transparent_6px_12px)]"
                    style={{ top: (Math.max(cl.startMin, startMin) - startMin) * PX, height: (Math.min(cl.endMin, endMin) - Math.max(cl.startMin, startMin)) * PX }}
                    title={cl.reason}
                  />
                ))}
                {hours.map((m) => (
                  <div key={m} className="pointer-events-none absolute inset-x-0 border-t border-[var(--cara-rule)] opacity-60" style={{ top: (m - startMin) * PX }} />
                ))}
                {mine.map((a) => {
                  const s = istMin(a.startAt);
                  const e = istMin(a.endAt) || 1440;
                  const l = laneOf.get(a.id) ?? { lane: 0, of: 1 };
                  const tone = a.visible ? (STATUS_TONE[a.status] ?? "ink") : "neutral";
                  return (
                    <button
                      key={a.id}
                      className={`tag-${tone} absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight shadow-sm`}
                      style={{
                        top: (s - startMin) * PX + 1,
                        height: Math.max((e - s) * PX - 2, 16),
                        left: `calc(${(l.lane / l.of) * 100}% + 2px)`,
                        width: `calc(${100 / l.of}% - 4px)`,
                        background: "var(--tag-fill)",
                        borderColor: "var(--tag-line)",
                        color: "var(--tag-ink)",
                      }}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onOpen(a.id);
                      }}
                      title={`${a.patientName ?? "Booked"} · ${fmtRange(a.startAt, a.endAt)}${a.typeName ? ` · ${a.typeName}` : ""}`}
                    >
                      <div className="flex items-center gap-1 font-semibold">
                        <Flags a={a} />
                        <span className="truncate">{a.patientName ?? "Booked"}</span>
                      </div>
                      {a.typeName && <div className="truncate opacity-90">{a.typeName}</div>}
                      <div className="truncate opacity-80">{STATUS_LABEL[a.status]}</div>
                    </button>
                  );
                })}
                {nowMin !== null && nowMin >= startMin && nowMin <= endMin && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-[#e2453b]" style={{ top: (nowMin - startMin) * PX }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 text-[11px] text-cara-muted">
        {fmtDay(dateKey)} · hatched = not working / closed{canBookHere ? " · click an open time to book" : ""}
      </div>
    </div>
  );
}

// ── Week ────────────────────────────────────────────────────────────────────

export function WeekView({
  weekStartKey,
  appts,
  chain,
  roster,
  showDoctor,
  onOpen,
}: {
  weekStartKey: string;
  appts: CalendarAppointment[];
  chain: boolean;
  roster: WeekRosterDay[] | null;
  showDoctor: boolean;
  onOpen: (id: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStartKey, i));
  return (
    <div className="cara-card overflow-x-auto">
      <div className="grid min-w-[980px] grid-cols-7 divide-x divide-[var(--cara-rule)]">
        {days.map((d) => {
          const r = roster?.find((x) => x.dateKey === d);
          const list = appts.filter((a) => keyOf(a.startAt) === d);
          return (
            <div key={d} className="min-h-[18rem]">
              <div className="border-b border-cara-rule px-2 py-1.5">
                <div className="text-[12.5px] font-semibold text-cara-ink">{fmtDay(d)}</div>
                {r && (
                  <div className="text-[10.5px] text-cara-muted">
                    {r.off ? <span className="txt-bad">Off: {r.off}</span> : r.places.length ? r.places.map((p) => `${p.branchName} ${hhmm(p.startMin)}–${hhmm(p.endMin)}`).join(" → ") : "Not rostered"}
                  </div>
                )}
                <div className="text-[10.5px] text-cara-faint">{list.length} appt{list.length === 1 ? "" : "s"}</div>
              </div>
              <div className="space-y-1 p-1.5">
                {list.map((a) => (
                  <button
                    key={a.id}
                    className={`tag-${a.visible ? (STATUS_TONE[a.status] ?? "ink") : "neutral"} block w-full rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight`}
                    style={{ background: "var(--tag-fill)", borderColor: "var(--tag-line)", color: "var(--tag-ink)" }}
                    onClick={() => onOpen(a.id)}
                  >
                    <div className="font-semibold">{fmtTime(a.startAt)} · {a.patientName ?? "Booked"}</div>
                    {a.typeName && <div className="truncate">{a.typeName}</div>}
                    {(showDoctor || chain) && (
                      <div className="truncate opacity-80">
                        {showDoctor ? doctorOf(a) : ""}
                        {showDoctor && chain ? " · " : ""}
                        {chain ? a.branchName : ""}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Front-desk board (1.B) ──────────────────────────────────────────────────

const BOARD = [
  { key: "expected", label: "Expected", statuses: ["tentative", "booked", "confirmed"] },
  { key: "waiting", label: "Waiting (checked in)", statuses: ["checked_in"] },
  { key: "with", label: "With the doctor", statuses: ["in_progress"] },
  { key: "done", label: "Done", statuses: ["completed"] },
  { key: "noshow", label: "No-show", statuses: ["no_show"] },
];

const NEXT_ON_BOARD: Record<string, string> = {
  tentative: "checked_in",
  booked: "checked_in",
  confirmed: "checked_in",
  checked_in: "in_progress",
  in_progress: "completed",
};

export function BoardView({
  appts,
  canRunDay,
  chain,
  nowMs,
  onOpen,
}: {
  appts: CalendarAppointment[];
  canRunDay: boolean;
  chain: boolean;
  /// Server time at render, so "running late" is stable across re-renders.
  nowMs: number;
  onOpen: (id: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const now = nowMs;

  function advance(id: string, to: string) {
    startTransition(async () => {
      const r = await setAppointmentStatus({ id, to });
      if (!r.ok) alert(r.error);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-3 md:grid-cols-5">
      {BOARD.map((col) => {
        const list = appts.filter((a) => col.statuses.includes(a.status));
        return (
          <div key={col.key} className="rounded-xl bg-[var(--cara-surface-2)] p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[12px] font-semibold text-cara-ink">{col.label}</span>
              <span className="text-[11px] text-cara-muted">{list.length}</span>
            </div>
            <div className="space-y-2">
              {list.map((a) => {
                const next = NEXT_ON_BOARD[a.status];
                const late = col.key === "expected" && new Date(a.startAt).getTime() < now - 15 * 60_000;
                return (
                  <div key={a.id} className="cara-card space-y-1 p-2.5">
                    <button className="block w-full text-left" onClick={() => onOpen(a.id)}>
                      <div className="flex items-center gap-1 text-[12.5px] font-semibold text-cara-ink">
                        <span className="truncate">{a.patientName ?? "Booked"}</span>
                        <Flags a={a} />
                      </div>
                      <div className="text-[11.5px] text-cara-muted">
                        {fmtTime(a.startAt)} · {doctorOf(a)}
                        {chain ? ` · ${a.branchName}` : ""}
                      </div>
                      {a.typeName && <div className="truncate text-[11.5px]">{a.typeName}</div>}
                      <IntakeMark a={a} />
                      {late && <div className="text-[11px] font-medium txt-warn">Running late</div>}
                    </button>
                    {canRunDay && a.visible && next && (
                      <button className="cara-btn w-full" disabled={pending} onClick={() => advance(a.id, next)}>
                        {STATUS_ACTION[next]}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
