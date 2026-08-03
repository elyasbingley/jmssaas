import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { CalendarEvent } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { addDays, addMonths, formatEventTimeRange, isSameDay, monthGridDays, startOfMonth, startOfWeek } from "../lib/datetime";

type ViewMode = "day" | "week" | "month" | "year";
const VIEW_MODES: ViewMode[] = ["day", "week", "month", "year"];
const VIEW_MODE_LABELS: Record<ViewMode, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function fetchEvents(): Promise<CalendarEvent[]> {
  const { data, error } = await supabase.from("calendar_events").select("*").order("start_at", { ascending: true });
  if (error) throw error;
  return data as CalendarEvent[];
}

export default function CalendarPage() {
  const { data: events, isLoading } = useQuery({ queryKey: ["calendar-events"], queryFn: fetchEvents });

  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState(new Date());

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events ?? []) {
      const key = new Date(event.start_at).toDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    return map;
  }, [events]);

  const eventsOn = (day: Date) => eventsByDay.get(day.toDateString()) ?? [];

  const goToday = () => setAnchor(new Date());
  const shiftAnchor = (direction: 1 | -1) => {
    if (viewMode === "day") setAnchor((d) => addDays(d, direction));
    else if (viewMode === "week") setAnchor((d) => addDays(d, 7 * direction));
    else if (viewMode === "month") setAnchor((d) => addMonths(d, direction));
    else setAnchor((d) => new Date(d.getFullYear() + direction, d.getMonth(), 1));
  };

  const openDay = (day: Date) => {
    setAnchor(day);
    setViewMode("day");
  };

  const openMonth = (monthDate: Date) => {
    setAnchor(monthDate);
    setViewMode("month");
  };

  const renderEventRow = (event: CalendarEvent) => (
    <Link
      key={event.id}
      to={`/calendar/${event.id}`}
      className="block border-b border-gray-100 py-2 last:border-0 hover:bg-gray-50"
    >
      <p className="text-xs font-semibold text-blue-700">{formatEventTimeRange(event.start_at, event.end_at, event.all_day)}</p>
      <p className="text-sm font-medium text-gray-900">{event.title}</p>
    </Link>
  );

  const renderDayView = () => {
    const dayEvents = eventsOn(anchor);
    return (
      <div className="p-4">
        <h2 className="mb-3 text-base font-bold text-gray-900">
          {anchor.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </h2>
        {dayEvents.length === 0 ? <p className="text-sm text-gray-500">No events.</p> : dayEvents.map(renderEventRow)}
      </div>
    );
  };

  const renderWeekView = () => {
    const weekStart = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    return (
      <div className="grid grid-cols-7 gap-3 p-4">
        {days.map((day) => {
          const dayEvents = eventsOn(day);
          return (
            <button key={day.toDateString()} onClick={() => openDay(day)} className="rounded-lg border border-gray-200 p-2 text-left hover:bg-gray-50">
              <p className={`mb-1 text-xs font-bold ${isSameDay(day, new Date()) ? "text-blue-700" : "text-gray-700"}`}>
                {day.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
              </p>
              {dayEvents.length === 0 ? (
                <p className="text-xs text-gray-400">No events</p>
              ) : (
                dayEvents.map((e) => (
                  <p key={e.id} className="truncate text-xs text-gray-700">
                    {e.title}
                  </p>
                ))
              )}
            </button>
          );
        })}
      </div>
    );
  };

  const renderMonthView = () => {
    const gridDays = monthGridDays(startOfMonth(anchor));
    const today = new Date();
    return (
      <div className="flex h-full flex-col p-4">
        <h2 className="mb-3 flex-shrink-0 text-center text-base font-bold text-gray-900">
          {MONTH_LABELS[anchor.getMonth()]} {anchor.getFullYear()}
        </h2>
        <div className="grid flex-shrink-0 grid-cols-7 border-b border-gray-200 pb-2">
          {WEEKDAY_LABELS.map((label) => (
            <p key={label} className="text-center text-xs font-semibold text-gray-400">
              {label}
            </p>
          ))}
        </div>
        {/* 6 rows x 7 cols filling the remaining height exactly - no
            aspect-square (which sized each cell off its width and forced
            the grid taller than the viewport on anything but a very
            narrow window) - grid-rows-6 with a flex-1 parent means each
            row's height comes from available space, not content. */}
        <div className="grid flex-1 grid-cols-7 grid-rows-6">
          {gridDays.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const dayEvents = eventsOn(day);
            return (
              <button
                key={day.toDateString()}
                onClick={() => openDay(day)}
                className="flex min-h-0 flex-col items-center justify-center gap-1 overflow-hidden border border-gray-100 hover:bg-gray-50"
              >
                <span
                  className={`text-sm ${!inMonth ? "text-gray-300" : isSameDay(day, today) ? "font-extrabold text-blue-700" : "text-gray-900"}`}
                >
                  {day.getDate()}
                </span>
                {dayEvents.length > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-blue-700" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderYearView = () => {
    const year = anchor.getFullYear();
    return (
      <div className="grid grid-cols-3 gap-4 p-4 md:grid-cols-4">
        {MONTH_LABELS.map((label, i) => {
          const monthDate = new Date(year, i, 1);
          const count = (events ?? []).filter(
            (e) => new Date(e.start_at).getFullYear() === year && new Date(e.start_at).getMonth() === i
          ).length;
          return (
            <button
              key={label}
              onClick={() => openMonth(monthDate)}
              className="rounded-lg bg-gray-100 p-4 text-left hover:bg-gray-200"
            >
              <p className="font-bold text-gray-900">{label}</p>
              <p className="text-xs text-gray-500">
                {count} event{count === 1 ? "" : "s"}
              </p>
            </button>
          );
        })}
      </div>
    );
  };

  const heading =
    viewMode === "day"
      ? anchor.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
      : viewMode === "week"
        ? `Week of ${startOfWeek(anchor).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`
        : viewMode === "month"
          ? `${MONTH_LABELS[anchor.getMonth()]} ${anchor.getFullYear()}`
          : String(anchor.getFullYear());

  return (
    <div className={`flex h-full flex-col p-8 ${viewMode === "month" ? "" : "overflow-y-auto"}`}>
      <div className="mb-4 flex flex-shrink-0 items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Calendar</h1>
        <Link to="/calendar/new" className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800">
          + New event
        </Link>
      </div>

      <div className="mb-4 flex flex-shrink-0 items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex gap-2">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
                viewMode === mode ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {VIEW_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => shiftAnchor(-1)} className="text-xl font-bold text-blue-700">
            &lsaquo;
          </button>
          <button onClick={goToday} className="text-sm font-bold text-gray-900 hover:underline">
            {heading}
          </button>
          <button onClick={() => shiftAnchor(1)} className="text-xl font-bold text-blue-700">
            &rsaquo;
          </button>
        </div>
      </div>

      <div
        className={`rounded-lg border border-gray-200 bg-white ${
          viewMode === "month" ? "min-h-0 flex-1 overflow-hidden" : "flex-shrink-0"
        }`}
      >
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : (
          <>
            {viewMode === "day" ? renderDayView() : null}
            {viewMode === "week" ? renderWeekView() : null}
            {viewMode === "month" ? renderMonthView() : null}
            {viewMode === "year" ? renderYearView() : null}
          </>
        )}
      </div>
    </div>
  );
}
