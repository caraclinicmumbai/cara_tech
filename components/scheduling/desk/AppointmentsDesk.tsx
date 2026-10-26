"use client";

// The appointments desk (§3.2 / §2.2): one calendar, two scopes — a branch, or the
// whole chain — and five views. State lives in the URL (view, date, branch, filters)
// so a front desk can bookmark its view and a link from a colleague opens the same
// thing. The server page loads the data for that URL; this shell draws it and owns
// the two modals (appointment card, booking drawer).
import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SlotFinder, type SlotPick } from "@/components/scheduling/SlotFinder";
import { AppointmentCard } from "./AppointmentCard";
import { BookingDrawer, type BookingPrefill } from "./BookingDrawer";
import { BoardView, ListView, ResourceView, WeekView } from "./views";
import type { CalendarAppointment, ColumnResource, DeskQuery, DeskViewer, Opt, TypeOpt, WeekRosterDay } from "./types";
import { VIEWS, addDays, fmtDay, fmtLongDay, istIso, weekStart } from "./ui";

export type DeskSummary = {
  appointments: number;
  guests: number;
  expected: number;
  waiting: number;
  inProgress: number;
  completed: number;
  noShow: number;
  overbooked: number;
};

export function AppointmentsDesk({
  query,
  today,
  nowMin,
  nowMs,
  viewer,
  branches,
  doctors,
  staff,
  types,
  appts,
  columns,
  open,
  closures,
  roster,
  summary,
}: {
  query: DeskQuery;
  today: string;
  nowMin: number;
  nowMs: number;
  viewer: DeskViewer;
  branches: Opt[];
  doctors: Opt[];
  staff: Opt[];
  types: TypeOpt[];
  appts: CalendarAppointment[];
  columns: ColumnResource[];
  open: { startMin: number; endMin: number }[];
  closures: { startMin: number; endMin: number; reason: string }[];
  roster: WeekRosterDay[] | null;
  summary: DeskSummary;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [cardId, setCardId] = useState<string | null>(null);
  const [booking, setBooking] = useState<BookingPrefill | null>(null);
  // Each opening of the drawer gets a fresh mount (and so fresh state).
  const [bookingKey, setBookingKey] = useState(0);
  const openBooking = (p: BookingPrefill) => {
    setBookingKey((k) => k + 1);
    setBooking(p);
  };
  const chain = query.branch === "all";
  const mayBookAt = (branchId: string) => viewer.canBook && (viewer.bookAnyBranch || viewer.homeBranchId === branchId);
  const canBookHere = !chain && mayBookAt(query.branch);

  function go(patch: Partial<DeskQuery>) {
    const next = { ...query, ...patch };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) sp.set(k, v);
    router.push(`${pathname}?${sp.toString()}`);
  }

  const step = query.view === "week" ? 7 : 1;
  const heading = query.view === "week" ? `Week of ${fmtDay(weekStart(query.date))}` : fmtLongDay(query.date);
  const branchName = chain ? "All branches" : (branches.find((b) => b.id === query.branch)?.name ?? "");

  const prefillBase = useMemo<BookingPrefill>(
    () => ({ branchId: chain ? undefined : query.branch, doctorId: query.doctor || undefined, typeId: query.type || undefined, dateKey: query.date }),
    [chain, query.branch, query.doctor, query.type, query.date],
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="cara-card space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button className="cara-btn" onClick={() => go({ date: addDays(query.date, -step) })} aria-label="Previous">‹</button>
          <button className="cara-btn" onClick={() => go({ date: addDays(query.date, step) })} aria-label="Next">›</button>
          <button className="cara-btn" onClick={() => go({ date: today })}>Today</button>
          <input type="date" className="cara-input w-auto!" value={query.date} onChange={(e) => e.target.value && go({ date: e.target.value })} aria-label="Date" />
          <div className="ml-1 text-[15px] font-semibold text-cara-ink">{heading}</div>
          <div className="flex-1" />
          {viewer.canBook && query.view !== "find" && (
            <button className="cara-btn cara-btn-primary" onClick={() => openBooking({ ...prefillBase })}>+ Appointment</button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {VIEWS.map((v) => (
            <button key={v.key} className={`cara-chip ${query.view === v.key ? "on" : ""}`} onClick={() => go({ view: v.key })}>
              {v.label}
            </button>
          ))}
        </div>
        {query.view !== "find" && (
          <div className="flex flex-wrap items-center gap-2">
            <select className="cara-select w-auto!" value={query.branch} onChange={(e) => go({ branch: e.target.value })} aria-label="Branch">
              {branches.length > 1 && <option value="all">All branches (chain view)</option>}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.id === viewer.homeBranchId ? " — my branch" : ""}
                </option>
              ))}
            </select>
            <select className="cara-select w-auto!" value={query.doctor} onChange={(e) => go({ doctor: e.target.value })} aria-label="Doctor">
              <option value="">All doctors</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            {staff.length > 0 && (
              <select className="cara-select w-auto!" value={query.staff} onChange={(e) => go({ staff: e.target.value })} aria-label="OT team member">
                <option value="">All OT team</option>
                {staff.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            <select className="cara-select w-auto! max-w-[18rem]!" value={query.type} onChange={(e) => go({ type: e.target.value })} aria-label="Service">
              <option value="">All services</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            {(query.doctor || query.staff || query.type) && (
              <button className="cara-btn" onClick={() => go({ doctor: "", staff: "", type: "" })}>Clear filters</button>
            )}
          </div>
        )}
        {!chain && !viewer.seesAllBranches && query.branch !== viewer.homeBranchId && query.view !== "find" && (
          <div className="cara-notice is-info text-[12.5px]">
            You&rsquo;re viewing another branch: appointments show as &ldquo;Booked&rdquo; without patient details, and booking here is for the call centre or a branch manager.
          </div>
        )}
      </div>

      {/* View */}
      {query.view === "resources" &&
        (chain ? (
          <div className="space-y-2">
            <div className="cara-notice is-info text-[12.5px]">Resource columns are per branch — showing the chain as a list. Pick a branch for columns.</div>
            <ListView appts={appts} chain onOpen={setCardId} />
          </div>
        ) : (
          <ResourceView
            dateKey={query.date}
            columns={columns}
            appts={appts}
            open={open}
            closures={closures}
            nowMin={query.date === today ? nowMin : null}
            canBookHere={canBookHere}
            onOpen={setCardId}
            onSlot={(c, minute) =>
              openBooking({
                ...prefillBase,
                branchId: query.branch,
                doctorId: c.kind === "doctor" ? c.id : prefillBase.doctorId,
                dateKey: query.date,
                startAt: istIso(query.date, minute),
              })
            }
          />
        ))}
      {query.view === "list" && <ListView appts={appts} chain={chain} onOpen={setCardId} />}
      {query.view === "week" && (
        <WeekView weekStartKey={weekStart(query.date)} appts={appts} chain={chain} roster={roster} showDoctor={!query.doctor} onOpen={setCardId} />
      )}
      {query.view === "board" && <BoardView appts={appts} canRunDay={viewer.canCheckin} chain={chain} nowMs={nowMs} onOpen={setCardId} />}
      {query.view === "find" && (
        <SlotFinder
          branches={branches}
          types={types}
          doctors={doctors}
          today={today}
          initial={{ branchId: chain ? "all" : query.branch, doctorId: query.doctor, typeId: query.type, dateKey: query.date }}
          canPick={mayBookAt}
          onPick={viewer.canBook ? (p: SlotPick) => openBooking({ branchId: p.branchId, typeId: p.typeId, doctorId: p.doctorId || undefined, dateKey: p.dateKey, startAt: p.startAt }) : undefined}
        />
      )}

      {/* Summary bar */}
      {query.view !== "find" && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-cara-rule bg-[var(--cara-surface)] px-4 py-2 text-[12px] text-cara-muted">
          <span>{branchName}</span>
          <span>Appointments: <b className="text-cara-ink">{summary.appointments}</b></span>
          <span>Guests: <b className="text-cara-ink">{summary.guests}</b></span>
          <span>Expected: <b className="text-cara-ink">{summary.expected}</b></span>
          <span>Waiting: <b className="text-cara-ink">{summary.waiting}</b></span>
          <span>In progress: <b className="text-cara-ink">{summary.inProgress}</b></span>
          <span>Completed: <b className="text-cara-ink">{summary.completed}</b></span>
          <span>No-show: <b className="text-cara-ink">{summary.noShow}</b></span>
          {summary.overbooked > 0 && <span className="txt-warn">Doctor double-booked: {summary.overbooked}</span>}
        </div>
      )}

      {cardId && <AppointmentCard key={cardId} id={cardId} onClose={() => setCardId(null)} />}
      {booking && (
        <BookingDrawer
          key={bookingKey}
          onClose={() => setBooking(null)}
          prefill={booking}
          branches={branches}
          types={types}
          doctors={doctors}
          viewer={viewer}
        />
      )}
    </div>
  );
}
