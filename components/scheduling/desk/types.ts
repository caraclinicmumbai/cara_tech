// Plain, serialisable shapes the server page hands the desk. Kept separate from the
// server-only modules so client components can import them freely.
import type { CalendarAppointment, ColumnResource } from "@/lib/scheduling/calendar";

export type { CalendarAppointment, ColumnResource };

export type Opt = { id: string; name: string };
export type TypeOpt = { id: string; label: string; durationMin: number; bufferAfterMin: number; needsDoctor: boolean };

export type DeskViewer = {
  homeBranchId: string | null;
  resourceId: string | null;
  canBook: boolean;
  canCheckin: boolean;
  canOverride: boolean;
  bookAnyBranch: boolean;
  seesAllBranches: boolean;
};

export type DeskQuery = {
  view: "resources" | "list" | "week" | "board" | "find";
  date: string;
  branch: string; // branch id or "all"
  doctor: string;
  staff: string;
  type: string;
};

/// A doctor's roster per day of the week view, when the week is filtered to one doctor.
export type WeekRosterDay = { dateKey: string; places: { branchName: string; startMin: number; endMin: number }[]; off: string | null };
