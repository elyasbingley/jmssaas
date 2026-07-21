// No native date/time picker dependency yet (see docs known-gaps) - events
// are entered as plain "YYYY-MM-DD" + "HH:MM" text fields, same style as the
// due_date/expiry_date fields already used elsewhere in the app, and
// combined into an ISO datetime using the device's local timezone.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoToLocalDateInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isoToLocalTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function combineLocalDateTimeToIso(date: string, time: string): string | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatEventDateHeading(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

export function formatEventTimeRange(startIso: string, endIso: string, allDay: boolean): string {
  if (allDay) return "All day";
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  return `${new Date(startIso).toLocaleTimeString("en-AU", opts)} - ${new Date(endIso).toLocaleTimeString("en-AU", opts)}`;
}
