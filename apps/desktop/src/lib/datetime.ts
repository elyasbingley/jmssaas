// Port of apps/mobile/lib/datetime.ts - pure functions, no React Native
// dependency, so this is a verbatim copy.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoToLocalDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatEventTimeRange(startIso: string, endIso: string, allDay: boolean): string {
  if (allDay) return "All day";
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  return `${new Date(startIso).toLocaleTimeString("en-AU", opts)} - ${new Date(endIso).toLocaleTimeString("en-AU", opts)}`;
}

// --- Calendar grid helpers, for the Day/Week/Month/Year views ---

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Minutes between `dayStart` (any local midnight) and `d` - deliberately
// not "minutes since midnight of `d` itself", since the whole point is to
// position/size an event clipped to someone else's day boundary (an
// overnight event's tail end, clipped to end at the NEXT day's midnight,
// needs to read as 1440, not 0).
export function minutesFromDayStart(dayStart: Date, d: Date): number {
  return (d.getTime() - dayStart.getTime()) / 60_000;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

export function addMonths(d: Date, n: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + n);
  return result;
}

// Monday-start week, matching AU convention.
export function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), diff);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// 6 rows x 7 columns, Monday-start, covering the full month plus enough of
// the surrounding months to fill the grid - the standard month-view layout.
export function monthGridDays(monthStart: Date): Date[] {
  const gridStart = startOfWeek(monthStart);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

// Local "YYYY-MM-DDTHH:mm" for a plain <input type="datetime-local">.
export function toDateTimeLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
