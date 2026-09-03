import type { CalendarEvent, CalendarEventCategory, RecurrenceFrequency, RecurrenceRule } from "./types";

// Which of the 4 color categories an event belongs to. category_override
// (set directly from the editor's "Event type" picker) wins when present -
// it exists specifically so an event's displayed type/color can be chosen
// independently of what it's actually linked to (e.g. color a job-linked
// event as "General", or an unlinked event as "Job"). Falls back to
// deriving from job_card_id/task_id/source when there's no override.
// Order matters: a 'google_personal' event is never job/task-linked (see
// the google_calendar_sync migration) and never has an override (the
// column's own check constraint excludes 'personal' - see the
// calendar_category_override migration), so checking source first is just
// documentation of that invariant, not load-bearing.
export function categoryForEvent(
  event: Pick<CalendarEvent, "source" | "job_card_id" | "task_id" | "category_override">
): CalendarEventCategory {
  if (event.category_override) return event.category_override;
  if (event.source === "google_personal") return "personal";
  if (event.job_card_id) return "job";
  if (event.task_id) return "task";
  return "general";
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Human-readable label matching Google Calendar's own phrasing closely
// enough to be recognizable ("Weekly on Saturday", "Every 2 weeks on Mon,
// Wed", "Monthly on day 15", "Daily") - shown in the event popup and as
// the recurrence dropdown's selected-value text.
export function describeRecurrence(rule: RecurrenceRule | null, firstStart: Date): string {
  if (!rule) return "Does not repeat";
  const { freq, interval } = rule;

  if (freq === "daily") {
    return interval === 1 ? "Daily" : `Every ${interval} days`;
  }

  if (freq === "weekly") {
    const days = rule.byWeekday?.length ? rule.byWeekday : [firstStart.getDay()];
    const dayLabel = days.length === 1 ? WEEKDAY_NAMES[days[0]!] : days.map((d) => WEEKDAY_SHORT[d]).join(", ");
    return interval === 1 ? `Weekly on ${dayLabel}` : `Every ${interval} weeks on ${dayLabel}`;
  }

  // monthly
  return interval === 1 ? `Monthly on day ${firstStart.getDate()}` : `Every ${interval} months on day ${firstStart.getDate()}`;
}

export interface RecurrenceOccurrence {
  start: Date;
  end: Date;
}

// Bounds generation regardless of how the rule's own end condition is
// set - a 'never'-ending weekly event still only gets occurrences
// materialized 2 years out / 500 rows, whichever comes first. There's no
// background job to lazily extend a series past this horizon (a
// deliberate, documented limitation - see docs/SETUP.md) - re-saving the
// event with a later end date is the workaround if someone actually needs
// a series to run longer than that.
const MAX_OCCURRENCES = 500;
const MAX_HORIZON_YEARS = 2;

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function setSameTimeOfDay(date: Date, reference: Date): Date {
  const result = new Date(date);
  result.setHours(reference.getHours(), reference.getMinutes(), reference.getSeconds(), reference.getMilliseconds());
  return result;
}

// Clamps to the last real day of the target month when the reference
// day-of-month doesn't exist there (e.g. the 31st in a 30-day month) -
// matches the common "monthly on this day" behavior other calendar apps
// use rather than skipping the month or rolling into the next one.
function addMonthsClamped(date: Date, months: number, dayOfMonth: number): Date {
  const result = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return setSameTimeOfDay(result, date);
}

// Generates every occurrence's {start, end} pair for a recurring event,
// given the rule and the first occurrence's own start/end (each
// occurrence keeps the same duration as the first). Pure and
// deterministic - both the "create a new recurring event" flow and the
// "regenerate from here for a this-and-following edit" flow (see
// task #69) call this the same way.
export function generateRecurrenceOccurrences(rule: RecurrenceRule, firstStart: Date, firstEnd: Date): RecurrenceOccurrence[] {
  const durationMs = firstEnd.getTime() - firstStart.getTime();
  const horizon = new Date(firstStart);
  horizon.setFullYear(horizon.getFullYear() + MAX_HORIZON_YEARS);
  const endDate = rule.endType === "on" && rule.endDate ? new Date(`${rule.endDate}T23:59:59`) : null;
  const maxCount = rule.endType === "after" && rule.count ? Math.min(rule.count, MAX_OCCURRENCES) : MAX_OCCURRENCES;

  const starts: Date[] = [];

  if (rule.freq === "daily") {
    let cursor = new Date(firstStart);
    while (starts.length < maxCount && cursor <= horizon && (!endDate || cursor <= endDate)) {
      starts.push(new Date(cursor));
      cursor = addDays(cursor, rule.interval);
    }
  } else if (rule.freq === "weekly") {
    const byWeekday = rule.byWeekday?.length ? [...rule.byWeekday].sort((a, b) => a - b) : [firstStart.getDay()];
    // Walk week-by-week (in `interval`-week steps) from the start of
    // firstStart's own week, emitting one occurrence per matching weekday
    // that falls on/after firstStart, in chronological order.
    let weekStart = addDays(firstStart, -firstStart.getDay());
    while (starts.length < maxCount && weekStart <= horizon) {
      for (const weekday of byWeekday) {
        const candidate = setSameTimeOfDay(addDays(weekStart, weekday), firstStart);
        if (candidate < firstStart) continue;
        if (candidate > horizon) break;
        if (endDate && candidate > endDate) continue;
        starts.push(candidate);
        if (starts.length >= maxCount) break;
      }
      weekStart = addDays(weekStart, 7 * rule.interval);
    }
  } else {
    // monthly
    const dayOfMonth = firstStart.getDate();
    let cursor = new Date(firstStart);
    let monthOffset = 0;
    while (starts.length < maxCount && cursor <= horizon && (!endDate || cursor <= endDate)) {
      starts.push(new Date(cursor));
      monthOffset += rule.interval;
      cursor = addMonthsClamped(firstStart, monthOffset, dayOfMonth);
    }
  }

  return starts.map((start) => ({ start, end: new Date(start.getTime() + durationMs) }));
}
