function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoToLocalDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatEventDateHeading(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

export function formatEventTimeRange(startIso: string, endIso: string, allDay: boolean): string {
  if (allDay) return "All day";
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  return `${new Date(startIso).toLocaleTimeString("en-AU", opts)} - ${new Date(endIso).toLocaleTimeString("en-AU", opts)}`;
}

// --- Calendar grid helpers, for the Day/Week/Month/Year views ---

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
