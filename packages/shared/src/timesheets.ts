import { addDays, daysBetween, toDayKey, type DateRange } from "./analytics";
import type { TimesheetActivity, TimesheetActivityType, TimesheetShift } from "./types";

// Timesheet maths shared by the mobile timers and the desktop reports, so
// "paid hours" means the same thing on the phone that recorded it and the
// report that totals it. Pure - "now" is always passed in.
//
// A shift is one clock-on to clock-off. Activities (job, travel, break,
// admin) are what the time was spent on; they belong to a shift by
// overlapping it, not by a key (see the migration for why). Paid time is
// the shift minus its breaks. Time in a shift with no activity logged is
// "unallocated" - still paid, just not attributed to anything.
//
// The database deliberately doesn't reject impossible times (an end before
// a start, two shifts overlapping) because rejecting a phone's upload
// stalls its whole sync queue. So nothing here trusts them: durations are
// clamped at zero and the oddities are reported as flags.

type Interval = Pick<TimesheetShift, "started_at" | "ended_at">;

const ms = (iso: string) => new Date(iso).getTime();

export function entryMinutes(entry: Interval, now: string): number {
  return Math.max(0, (ms(entry.ended_at ?? now) - ms(entry.started_at)) / 60000);
}

// Minutes of `inner` that fall inside `outer`.
export function overlapMinutes(inner: Interval, outer: Interval, now: string): number {
  const start = Math.max(ms(inner.started_at), ms(outer.started_at));
  const end = Math.min(ms(inner.ended_at ?? now), ms(outer.ended_at ?? now));
  return Math.max(0, (end - start) / 60000);
}

// 7.5 -> "7h 30m"; under an hour -> "45m".
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

// Decimal hours to two places, for tables and CSV (payroll wants 7.50).
export function minutesToHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

// The Monday of the week a day falls in.
export function weekStartOf(dayKey: string): string {
  // 1970-01-05 was a Monday.
  const offset = ((daysBetween("1970-01-05", dayKey) % 7) + 7) % 7;
  return addDays(dayKey, -offset);
}

export function weeksInRange(range: DateRange): string[] {
  const weeks: string[] = [];
  for (let week = weekStartOf(range.from); week <= range.to; week = addDays(week, 7)) weeks.push(week);
  return weeks;
}

export type ShiftFlag = "running" | "long" | "edited" | "manual" | "no_location" | "desktop" | "overlap";

export const SHIFT_FLAG_LABELS: Record<ShiftFlag, string> = {
  running: "Still clocked on",
  long: "Over 12 hours",
  edited: "Edited",
  manual: "Entered manually",
  no_location: "No location",
  // Clocked on from the desktop app - computers don't record a location.
  desktop: "From a computer",
  overlap: "Overlaps another shift",
};

const LONG_SHIFT_MINUTES = 12 * 60;

export interface ShiftSummary {
  shift: TimesheetShift;
  day: string;
  activities: TimesheetActivity[];
  totalMinutes: number;
  breakMinutes: number;
  paidMinutes: number;
  minutesByType: Record<TimesheetActivityType, number>;
  // Paid time with nothing logged against it.
  unallocatedMinutes: number;
  flags: ShiftFlag[];
}

export function summariseShift(shift: TimesheetShift, activities: TimesheetActivity[], allShifts: TimesheetShift[], now: string): ShiftSummary {
  const mine = activities.filter((a) => a.profile_id === shift.profile_id && overlapMinutes(a, shift, now) > 0);
  const minutesByType: Record<TimesheetActivityType, number> = { job: 0, travel: 0, break: 0, admin: 0 };
  for (const activity of mine) minutesByType[activity.activity_type] += overlapMinutes(activity, shift, now);

  const totalMinutes = entryMinutes(shift, now);
  const breakMinutes = Math.min(totalMinutes, minutesByType.break);
  const paidMinutes = totalMinutes - breakMinutes;
  const allocated = minutesByType.job + minutesByType.travel + minutesByType.admin;

  const flags: ShiftFlag[] = [];
  if (!shift.ended_at) flags.push("running");
  if (totalMinutes > LONG_SHIFT_MINUTES) flags.push("long");
  if (shift.edited_at) flags.push("edited");
  if (shift.source === "manual") flags.push("manual");
  if (shift.source === "timer" && shift.start_latitude === null) flags.push("no_location");
  if (shift.source === "desktop") flags.push("desktop");
  if (allShifts.some((other) => other.id !== shift.id && other.profile_id === shift.profile_id && overlapMinutes(other, shift, now) > 0)) flags.push("overlap");

  return {
    shift,
    day: toDayKey(shift.started_at),
    activities: mine.sort((a, b) => a.started_at.localeCompare(b.started_at)),
    totalMinutes,
    breakMinutes,
    paidMinutes,
    minutesByType,
    unallocatedMinutes: Math.max(0, paidMinutes - allocated),
    flags,
  };
}

// Every shift that started in the range, newest first. A shift counts on
// the day it started, including one that runs past midnight.
export function summariseShifts(shifts: TimesheetShift[], activities: TimesheetActivity[], range: DateRange, now: string): ShiftSummary[] {
  return shifts
    .filter((s) => {
      const day = toDayKey(s.started_at);
      return day >= range.from && day <= range.to;
    })
    .map((s) => summariseShift(s, activities, shifts, now))
    .sort((a, b) => b.shift.started_at.localeCompare(a.shift.started_at));
}

export interface WeekRow {
  profileId: string;
  weekStart: string;
  // Paid minutes Monday..Sunday.
  days: number[];
  paidMinutes: number;
  jobMinutes: number;
  breakMinutes: number;
  shifts: ShiftSummary[];
  hasRunning: boolean;
}

// One row per person per week that has any shift, weeks newest first then
// people in the order given.
export function weeklyRows(summaries: ShiftSummary[], profileOrder: string[]): WeekRow[] {
  const rows = new Map<string, WeekRow>();
  for (const summary of summaries) {
    const weekStart = weekStartOf(summary.day);
    const key = `${summary.shift.profile_id}|${weekStart}`;
    let row = rows.get(key);
    if (!row) {
      row = { profileId: summary.shift.profile_id, weekStart, days: [0, 0, 0, 0, 0, 0, 0], paidMinutes: 0, jobMinutes: 0, breakMinutes: 0, shifts: [], hasRunning: false };
      rows.set(key, row);
    }
    const dayIndex = daysBetween(weekStart, summary.day);
    row.days[dayIndex] = (row.days[dayIndex] ?? 0) + summary.paidMinutes;
    row.paidMinutes += summary.paidMinutes;
    row.jobMinutes += summary.minutesByType.job;
    row.breakMinutes += summary.breakMinutes;
    row.shifts.push(summary);
    if (!summary.shift.ended_at) row.hasRunning = true;
  }
  const order = new Map(profileOrder.map((id, index) => [id, index]));
  return [...rows.values()].sort(
    (a, b) => b.weekStart.localeCompare(a.weekStart) || (order.get(a.profileId) ?? 1e9) - (order.get(b.profileId) ?? 1e9)
  );
}

// A week can be signed off once it has finished and nothing in it is still
// running - the same two rules the database enforces on approval.
export function canApproveWeek(row: Pick<WeekRow, "weekStart" | "hasRunning">, today: string): boolean {
  return !row.hasRunning && addDays(row.weekStart, 7) <= today;
}

export interface WeekTotal {
  weekStart: string;
  paidMinutes: number;
  jobMinutes: number;
  // Paid time that wasn't on a job: travel, admin and unallocated.
  otherPaidMinutes: number;
}

// Total paid hours for every week touching the range (weeks with no time
// included, so a graph shows the gap), oldest first.
export function weekTotals(summaries: ShiftSummary[], range: DateRange): WeekTotal[] {
  const totals = new Map<string, WeekTotal>(weeksInRange(range).map((weekStart) => [weekStart, { weekStart, paidMinutes: 0, jobMinutes: 0, otherPaidMinutes: 0 }]));
  for (const summary of summaries) {
    const total = totals.get(weekStartOf(summary.day));
    if (!total) continue;
    total.paidMinutes += summary.paidMinutes;
    total.jobMinutes += Math.min(summary.paidMinutes, summary.minutesByType.job);
    total.otherPaidMinutes = total.paidMinutes - total.jobMinutes;
  }
  return [...totals.values()];
}

export interface JobActual {
  jobId: string;
  minutes: number;
  costCents: number;
  minutesByProfile: Map<string, number>;
}

// Time logged against each job (every 'job' activity, whether or not it
// sits inside a shift) and what that labour cost: each person's minutes at
// their own hourly cost, or the fallback rate for someone with no rate.
export function jobActuals(activities: TimesheetActivity[], costPerHourCentsByProfile: Map<string, number>, fallbackCostPerHourCents: number, now: string): Map<string, JobActual> {
  const actuals = new Map<string, JobActual>();
  for (const activity of activities) {
    if (activity.activity_type !== "job" || !activity.job_card_id) continue;
    const minutes = entryMinutes(activity, now);
    let actual = actuals.get(activity.job_card_id);
    if (!actual) {
      actual = { jobId: activity.job_card_id, minutes: 0, costCents: 0, minutesByProfile: new Map() };
      actuals.set(activity.job_card_id, actual);
    }
    const rate = costPerHourCentsByProfile.get(activity.profile_id) ?? fallbackCostPerHourCents;
    actual.minutes += minutes;
    actual.costCents += (minutes / 60) * rate;
    actual.minutesByProfile.set(activity.profile_id, (actual.minutesByProfile.get(activity.profile_id) ?? 0) + minutes);
  }
  for (const actual of actuals.values()) actual.costCents = Math.round(actual.costCents);
  return actuals;
}

// ---------------------------------------------------------------------------
// Timer transitions (mobile). Given what is currently running, what has to
// be written for each button. One shift and one activity can run at a
// time: starting an activity ends the one before it, starting anything
// while clocked off clocks on first, and clocking off ends everything.
// ---------------------------------------------------------------------------

export interface TimerState {
  // Every entry for this person that has no ended_at. Normally at most one
  // of each; more means a timer was left running (two phones, a restore) -
  // every transition closes all of them rather than leaving strays.
  openShifts: Pick<TimesheetShift, "id" | "started_at">[];
  openActivities: Pick<TimesheetActivity, "id" | "started_at" | "activity_type" | "job_card_id">[];
}

export type TimerWrite =
  | { kind: "open_shift" }
  | { kind: "close_shift"; id: string }
  | { kind: "open_activity"; activityType: TimesheetActivityType; jobCardId: string | null }
  | { kind: "close_activity"; id: string };

export type TimerAction =
  | { kind: "clock_on" }
  | { kind: "clock_off" }
  | { kind: "start"; activityType: TimesheetActivityType; jobCardId?: string | null }
  | { kind: "stop_activity" };

export function timerWrites(state: TimerState, action: TimerAction): TimerWrite[] {
  const closeActivities: TimerWrite[] = state.openActivities.map((a) => ({ kind: "close_activity", id: a.id }));
  switch (action.kind) {
    case "clock_on":
      return state.openShifts.length > 0 ? [] : [{ kind: "open_shift" }];
    case "clock_off":
      return [...closeActivities, ...state.openShifts.map((s): TimerWrite => ({ kind: "close_shift", id: s.id }))];
    case "stop_activity":
      return closeActivities;
    case "start": {
      const jobCardId = action.activityType === "job" ? action.jobCardId ?? null : null;
      const already = state.openActivities.length === 1 && state.openActivities[0]!.activity_type === action.activityType && (state.openActivities[0]!.job_card_id ?? null) === jobCardId;
      if (already && state.openShifts.length > 0) return [];
      return [
        ...(state.openShifts.length > 0 ? [] : [{ kind: "open_shift" } as TimerWrite]),
        ...closeActivities,
        { kind: "open_activity", activityType: action.activityType, jobCardId },
      ];
    }
  }
}
