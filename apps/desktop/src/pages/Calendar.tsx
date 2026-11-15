import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  categoryForEvent,
  DEFAULT_CALENDAR_CATEGORY_COLORS,
  generateRecurrenceOccurrences,
  type CalendarCategoryColors,
  type CalendarEvent,
  type JobCard,
  type Profile,
  type Task,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import {
  addDays,
  addMonths,
  formatEventTimeRange,
  isSameDay,
  minutesFromDayStart,
  monthGridDays,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "../lib/datetime";
import { pushCalendarEventDelete, pushCalendarEventUpsert } from "../lib/google-calendar-sync";
import { CalendarEventPopover } from "../components/CalendarEventPopover";
import { CalendarEventEditor, type CalendarEventSavePayload } from "../components/CalendarEventEditor";
import { RecurrenceScopeDialog, type RecurrenceEditScope } from "../components/RecurrenceScopeDialog";
import { ThemedButton } from "../components/theme/ThemedButton";

type ViewMode = "day" | "week" | "month" | "year";
const VIEW_MODES: ViewMode[] = ["day", "week", "month", "year"];
const VIEW_MODE_LABELS: Record<ViewMode, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type CalendarEventRow = CalendarEvent & {
  job_cards:
    | { id: string; title: string; number: string | null; assigned_technician_id: string | null; clients: { name: string; company_name: string | null } | null }
    | null;
  tasks: { id: string; title: string } | null;
};

// Widened job shape for the "Linked job" picker (CalendarEventEditor) -
// previously only id/title, so the dropdown showed nothing but the job
// title and an admin had to remember which job that was; now it can show
// the job number and client name too.
export type JobCardWithClient = JobCard & { clients: { name: string; company_name: string | null } | null };

async function fetchEvents(): Promise<CalendarEventRow[]> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*, job_cards(id, title, number, assigned_technician_id, clients(name, company_name)), tasks(id, title)")
    .order("start_at", { ascending: true });
  if (error) throw error;
  const events = data as CalendarEventRow[];

  // Every 'google_personal' row's base title/description/location is
  // always the literal 'Busy' placeholder (see the migration's own
  // comment on why) - overlay the real detail for whichever of these
  // belong to the signed-in user. calendar_event_personal_details'
  // owner-only RLS means this query only ever returns the caller's own
  // rows regardless of who else's personal events are mixed into
  // `events` above, so no extra filtering is needed here.
  const { data: ownDetails } = await supabase
    .from("calendar_event_personal_details")
    .select("calendar_event_id, title, description, location");
  if (ownDetails && ownDetails.length > 0) {
    const detailsByEventId = new Map(ownDetails.map((d) => [d.calendar_event_id, d]));
    for (const event of events) {
      const own = detailsByEventId.get(event.id);
      if (own) {
        event.title = own.title;
        event.description = own.description;
        event.location = own.location;
      }
    }
  }

  return events;
}
async function fetchJobCards(): Promise<JobCardWithClient[]> {
  const { data, error } = await supabase.from("job_cards").select("*, clients(name, company_name)").order("title");
  if (error) throw error;
  return data as JobCardWithClient[];
}
async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase.from("tasks").select("*").order("title");
  if (error) throw error;
  return data as Task[];
}
// Any profile can be assigned a job, not just role='technician' - see
// the chat thread's own note on why this was widened.
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}
async function fetchCategoryColors(tenantId: string): Promise<CalendarCategoryColors> {
  const { data, error } = await supabase.from("tenants").select("calendar_category_colors").eq("id", tenantId).single();
  if (error) throw error;
  return (data.calendar_category_colors as CalendarCategoryColors) ?? DEFAULT_CALENDAR_CATEGORY_COLORS;
}

// --- Day/Week hour-grid (Google-Calendar-shaped layout, JMS styling) ---

const HOUR_HEIGHT = 48; // px per hour
const TIME_COL_WIDTH = 52; // px, the left-hand hour-label gutter
const MIN_BLOCK_HEIGHT = 16; // px - keeps a very short event's title legible
const GRID_HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHourLabel(hour: number): string {
  if (hour === 0) return "";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

interface GridBlock {
  event: CalendarEventRow;
  top: number;
  height: number;
  column: number;
  totalColumns: number;
}

// Clips every timed (non-all_day) event to this single day's [00:00, 24:00)
// window and lays overlapping ones out in side-by-side columns, greedy-
// packed (first column whose last-placed event has already ended). This is
// also what correctly renders an overnight event (e.g. "Bed 10pm-7am") as
// a block in BOTH days it touches - the previous implementation bucketed
// an event into a single day by its start_at alone, so an overnight event
// never showed up the next morning at all.
function layoutDayColumn(day: Date, allEvents: CalendarEventRow[]): GridBlock[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);

  const clipped: { event: CalendarEventRow; startMin: number; endMin: number; column: number }[] = [];
  for (const event of allEvents) {
    if (event.all_day) continue;
    const eventStart = new Date(event.start_at);
    const eventEnd = new Date(event.end_at);
    if (eventEnd <= dayStart || eventStart >= dayEnd) continue;
    const clippedStart = eventStart < dayStart ? dayStart : eventStart;
    const clippedEnd = eventEnd > dayEnd ? dayEnd : eventEnd;
    const startMin = minutesFromDayStart(dayStart, clippedStart);
    clipped.push({ event, startMin, endMin: Math.max(minutesFromDayStart(dayStart, clippedEnd), startMin + 15), column: -1 });
  }
  clipped.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const results: GridBlock[] = [];
  let columnEnds: number[] = [];
  let cluster: typeof clipped = [];
  let clusterMaxEnd = -Infinity;

  const flushCluster = () => {
    const totalColumns = columnEnds.length;
    for (const item of cluster) {
      results.push({
        event: item.event,
        top: (item.startMin / 60) * HOUR_HEIGHT,
        height: Math.max(((item.endMin - item.startMin) / 60) * HOUR_HEIGHT, MIN_BLOCK_HEIGHT),
        column: item.column,
        totalColumns,
      });
    }
    cluster = [];
    columnEnds = [];
    clusterMaxEnd = -Infinity;
  };

  for (const item of clipped) {
    if (item.startMin >= clusterMaxEnd) flushCluster();
    let placed = columnEnds.findIndex((end) => end <= item.startMin);
    if (placed === -1) {
      placed = columnEnds.length;
      columnEnds.push(item.endMin);
    } else {
      columnEnds[placed] = item.endMin;
    }
    item.column = placed;
    cluster.push(item);
    clusterMaxEnd = Math.max(clusterMaxEnd, item.endMin);
  }
  flushCluster();

  return results;
}

export default function CalendarPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: events, isLoading } = useQuery({ queryKey: ["calendar-events"], queryFn: fetchEvents });
  const { data: jobCards } = useQuery({ queryKey: ["job-cards-all"], queryFn: fetchJobCards });
  const { data: tasks } = useQuery({ queryKey: ["tasks-all"], queryFn: fetchTasks });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });
  const { data: categoryColors } = useQuery({
    queryKey: ["calendar-category-colors", profile?.tenant_id],
    queryFn: () => fetchCategoryColors(profile!.tenant_id),
    enabled: !!profile,
  });
  const colors = categoryColors ?? DEFAULT_CALENDAR_CATEGORY_COLORS;
  const colorFor = (event: CalendarEventRow) => colors[categoryForEvent(event)];

  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState(new Date());

  // Live "now" line, Google-Calendar-style - re-ticks every minute rather
  // than once on mount, so leaving the tab open doesn't leave it visibly
  // stale.
  const [liveNow, setLiveNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setLiveNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Auto-scrolls the hour grid to a sensible start position whenever Day/
  // Week becomes active or the visible range changes - about 2 hours
  // before "now" if today's in view, otherwise a fixed 7am (matches
  // Google Calendar's own default landing scroll position).
  const gridScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewMode !== "day" && viewMode !== "week") return;
    const showingToday = viewMode === "day" ? isSameDay(anchor, liveNow) : true;
    const scrollToHour = showingToday ? Math.max(0, liveNow.getHours() - 2) : 7;
    gridScrollRef.current?.scrollTo({ top: scrollToHour * HOUR_HEIGHT });
    // Deliberately excludes liveNow - this should only re-run when the
    // *view* changes, not every minute the clock ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, anchor]);

  const [popover, setPopover] = useState<{ event: CalendarEventRow; anchorRect: DOMRect } | null>(null);
  const [editor, setEditor] = useState<{ mode: "new" | "edit"; event?: CalendarEventRow; initialDate?: Date } | null>(null);
  const [deleteScopeTarget, setDeleteScopeTarget] = useState<CalendarEventRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["calendar-events"] });

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventRow[]>();
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

  const openPopover = (event: CalendarEventRow, e: React.MouseEvent) => {
    e.stopPropagation();
    setPopover({ event, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
  };
  const openNewEvent = (date?: Date) => {
    setPopover(null);
    setEditor({ mode: "new", initialDate: date ?? anchor });
  };
  const openEditEvent = (event: CalendarEventRow) => {
    setPopover(null);
    setEditor({ mode: "edit", event });
  };

  // --- Save (create, edit, and recurrence generation) ---
  const saveMutation = useMutation({
    mutationFn: async ({ payload, scope }: { payload: CalendarEventSavePayload; scope: RecurrenceEditScope | null }) => {
      if (!profile) throw new Error("Not signed in");
      const editingEvent = editor?.mode === "edit" ? editor.event : undefined;

      const applyTechnicianAssignment = async (jobCardId: string | null, technicianId: string | null) => {
        if (!jobCardId) return;
        const { error } = await supabase.from("job_cards").update({ assigned_technician_id: technicianId }).eq("id", jobCardId);
        if (error) throw error;
      };

      // Creating a new event (recurring or not).
      if (!editingEvent) {
        await applyTechnicianAssignment(payload.job_card_id, payload.technician_id);

        if (!payload.recurrence_rule) {
          const { data, error } = await supabase
            .from("calendar_events")
            .insert({
              tenant_id: profile.tenant_id,
              title: payload.title,
              description: payload.description,
              location: payload.location,
              guests: payload.guests,
              start_at: payload.start_at,
              end_at: payload.end_at,
              all_day: payload.all_day,
              job_card_id: payload.job_card_id,
              task_id: payload.task_id,
              category_override: payload.category_override,
              created_by: profile.id,
            })
            .select("id")
            .single();
          if (error) throw error;
          await pushCalendarEventUpsert(data.id);
          return;
        }

        const occurrences = generateRecurrenceOccurrences(payload.recurrence_rule, new Date(payload.start_at), new Date(payload.end_at));
        const groupId = crypto.randomUUID();
        const rows = occurrences.map((occ) => ({
          tenant_id: profile.tenant_id,
          title: payload.title,
          description: payload.description,
          location: payload.location,
          guests: payload.guests,
          start_at: occ.start.toISOString(),
          end_at: occ.end.toISOString(),
          all_day: payload.all_day,
          job_card_id: payload.job_card_id,
          task_id: payload.task_id,
          category_override: payload.category_override,
          recurrence_rule: payload.recurrence_rule,
          recurrence_group_id: groupId,
          created_by: profile.id,
        }));
        const { data, error } = await supabase.from("calendar_events").insert(rows).select("id");
        if (error) throw error;
        const [firstRow, ...restRows] = data;
        if (firstRow) {
          await pushCalendarEventUpsert(firstRow.id);
          // Best-effort, don't block Save on possibly dozens of pushes -
          // google-calendar-reconcile's hourly sweep is the backstop for
          // any of these that don't land immediately.
          for (const row of restRows) void pushCalendarEventUpsert(row.id);
        }
        return;
      }

      // Editing a non-recurring event, or one not yet part of a series.
      if (!editingEvent.recurrence_group_id) {
        await applyTechnicianAssignment(
          payload.job_card_id,
          payload.job_card_id !== editingEvent.job_card_id || payload.technician_id !== editingEvent.job_cards?.assigned_technician_id
            ? payload.technician_id
            : null
        );

        if (!payload.recurrence_rule) {
          const { error } = await supabase
            .from("calendar_events")
            .update({
              title: payload.title,
              description: payload.description,
              location: payload.location,
              guests: payload.guests,
              start_at: payload.start_at,
              end_at: payload.end_at,
              all_day: payload.all_day,
              job_card_id: payload.job_card_id,
              task_id: payload.task_id,
              category_override: payload.category_override,
            })
            .eq("id", editingEvent.id);
          if (error) throw error;
          await pushCalendarEventUpsert(editingEvent.id);
          return;
        }

        // Turning a single event into the start of a new recurring series.
        const occurrences = generateRecurrenceOccurrences(payload.recurrence_rule, new Date(payload.start_at), new Date(payload.end_at));
        const groupId = crypto.randomUUID();
        const [first, ...rest] = occurrences;
        if (!first) throw new Error("Recurrence rule produced no occurrences");
        const { error: updateError } = await supabase
          .from("calendar_events")
          .update({
            title: payload.title,
            description: payload.description,
            location: payload.location,
            guests: payload.guests,
            start_at: first.start.toISOString(),
            end_at: first.end.toISOString(),
            all_day: payload.all_day,
            job_card_id: payload.job_card_id,
            task_id: payload.task_id,
            category_override: payload.category_override,
            recurrence_rule: payload.recurrence_rule,
            recurrence_group_id: groupId,
          })
          .eq("id", editingEvent.id);
        if (updateError) throw updateError;
        await pushCalendarEventUpsert(editingEvent.id);

        if (rest.length > 0) {
          const rows = rest.map((occ) => ({
            tenant_id: profile.tenant_id,
            title: payload.title,
            description: payload.description,
            location: payload.location,
            guests: payload.guests,
            start_at: occ.start.toISOString(),
            end_at: occ.end.toISOString(),
            all_day: payload.all_day,
            job_card_id: payload.job_card_id,
            task_id: payload.task_id,
            category_override: payload.category_override,
            recurrence_rule: payload.recurrence_rule,
            recurrence_group_id: groupId,
            created_by: profile.id,
          }));
          const { data } = await supabase.from("calendar_events").insert(rows).select("id");
          for (const row of data ?? []) void pushCalendarEventUpsert(row.id);
        }
        return;
      }

      // Editing one occurrence of an existing series - scope decides how
      // far the change spreads. See CalendarEventEditor's own comment on
      // why "this event only" still leaves recurrence_group_id in place.
      await applyTechnicianAssignment(payload.job_card_id, payload.technician_id);

      const { error: thisError } = await supabase
        .from("calendar_events")
        .update({
          title: payload.title,
          description: payload.description,
          location: payload.location,
          guests: payload.guests,
          start_at: payload.start_at,
          end_at: payload.end_at,
          all_day: payload.all_day,
          job_card_id: payload.job_card_id,
          task_id: payload.task_id,
          category_override: payload.category_override,
        })
        .eq("id", editingEvent.id);
      if (thisError) throw thisError;
      await pushCalendarEventUpsert(editingEvent.id);

      if (scope === "following" || scope === "all") {
        let query = supabase
          .from("calendar_events")
          .select("id, start_at, end_at")
          .eq("recurrence_group_id", editingEvent.recurrence_group_id)
          .neq("id", editingEvent.id);
        if (scope === "following") query = query.gte("start_at", editingEvent.start_at);
        const { data: others, error: othersError } = await query;
        if (othersError) throw othersError;

        const newStart = new Date(payload.start_at);
        const newTimeOfDayMs = newStart.getHours() * 3_600_000 + newStart.getMinutes() * 60_000 + newStart.getSeconds() * 1_000;
        const durationMs = new Date(payload.end_at).getTime() - newStart.getTime();

        for (const other of others ?? []) {
          const otherDate = new Date(other.start_at);
          const updateFields: Record<string, unknown> = {
            title: payload.title,
            description: payload.description,
            location: payload.location,
            guests: payload.guests,
            all_day: payload.all_day,
            job_card_id: payload.job_card_id,
            task_id: payload.task_id,
            category_override: payload.category_override,
          };
          if (!payload.all_day) {
            const dayStart = new Date(otherDate.getFullYear(), otherDate.getMonth(), otherDate.getDate());
            const shiftedStart = new Date(dayStart.getTime() + newTimeOfDayMs);
            updateFields.start_at = shiftedStart.toISOString();
            updateFields.end_at = new Date(shiftedStart.getTime() + durationMs).toISOString();
          }
          const { error: bulkError } = await supabase.from("calendar_events").update(updateFields).eq("id", other.id);
          if (bulkError) throw bulkError;
          void pushCalendarEventUpsert(other.id);
        }
      }
    },
    onSuccess: () => {
      invalidate();
      setEditor(null);
      setActionError(null);
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to save event"),
  });

  // --- Delete (single event, or a recurring series with scope) ---
  const deleteMutation = useMutation({
    mutationFn: async ({ event, scope }: { event: CalendarEventRow; scope: RecurrenceEditScope | null }) => {
      if (!event.recurrence_group_id || scope === "this" || scope === null) {
        const googleEventId = event.google_event_id;
        const googleConnectionId = event.google_calendar_connection_id;
        const { error } = await supabase.from("calendar_events").delete().eq("id", event.id);
        if (error) throw error;
        await pushCalendarEventDelete(event.id, googleEventId, googleConnectionId);
        return;
      }

      let query = supabase
        .from("calendar_events")
        .select("id, google_event_id, google_calendar_connection_id")
        .eq("recurrence_group_id", event.recurrence_group_id);
      if (scope === "following") query = query.gte("start_at", event.start_at);
      const { data: rows, error } = await query;
      if (error) throw error;

      const { error: deleteError } = await supabase
        .from("calendar_events")
        .delete()
        .in("id", (rows ?? []).map((r) => r.id));
      if (deleteError) throw deleteError;

      for (const row of rows ?? []) void pushCalendarEventDelete(row.id, row.google_event_id, row.google_calendar_connection_id);
    },
    onSuccess: () => {
      invalidate();
      setEditor(null);
      setPopover(null);
      setDeleteScopeTarget(null);
      setActionError(null);
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to delete event"),
  });

  const requestDelete = (event: CalendarEventRow) => {
    if (event.recurrence_group_id) {
      setPopover(null);
      setDeleteScopeTarget(event);
    } else if (confirm("Delete this event? This can't be undone.")) {
      deleteMutation.mutate({ event, scope: null });
    }
  };

  // Full-tile fill, not just a colored left edge - matches Google
  // Calendar's own event styling (a solid block in the category's color
  // with white text), rather than the previous gray chip with a colored
  // accent bar.
  const renderEventChip = (event: CalendarEventRow, dense = false) => (
    <button
      key={event.id}
      onClick={(e) => openPopover(event, e)}
      style={{ backgroundColor: colorFor(event) }}
      className={`block w-full truncate rounded px-1.5 text-left text-xs font-medium text-white opacity-90 hover:opacity-100 ${dense ? "py-0.5" : "py-1"}`}
    >
      {event.title}
    </button>
  );

  // Approximates the clicked slot to the nearest 15 minutes and opens
  // "new event" prefilled there - same click-an-empty-slot affordance
  // Google Calendar's own grid has.
  const handleGridSlotClick = (day: Date, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetMinutes = ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;
    const snapped = Math.max(0, Math.min(23 * 60 + 45, Math.round(offsetMinutes / 15) * 15));
    openNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(snapped / 60), snapped % 60));
  };

  // Shared by Day (a single-column grid) and Week (seven columns) - the
  // actual Google-Calendar-shaped layout: a sticky day-header row, an
  // optional all-day banner, then a scrollable 24-hour grid with each
  // timed event absolutely positioned/sized by its clipped start/end (see
  // layoutDayColumn) and a live "now" line on today's column.
  const renderTimeGrid = (days: Date[]) => {
    const allDayByDay = days.map((day) => eventsOn(day).filter((e) => e.all_day));
    const hasAllDay = allDayByDay.some((d) => d.length > 0);

    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-shrink-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
          <div style={{ width: TIME_COL_WIDTH }} className="flex-shrink-0" />
          {days.map((day) => {
            const today = isSameDay(day, liveNow);
            return (
              <button
                key={day.toDateString()}
                onClick={() => openDay(day)}
                className="flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2"
                style={{ borderLeft: "1px solid var(--jms-border)" }}
              >
                <span
                  className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: today ? "var(--jms-accent)" : "var(--jms-text-muted)" }}
                >
                  {day.toLocaleDateString("en-AU", { weekday: "short" })}
                </span>
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold"
                  style={{ backgroundColor: today ? "var(--jms-accent)" : "transparent", color: today ? "var(--jms-bg)" : "var(--jms-text)" }}
                >
                  {day.getDate()}
                </span>
              </button>
            );
          })}
        </div>

        {hasAllDay ? (
          <div className="flex flex-shrink-0 py-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
            <div style={{ width: TIME_COL_WIDTH }} className="flex-shrink-0" />
            {days.map((day, i) => (
              <div key={day.toDateString()} className="flex min-w-0 flex-1 flex-col gap-0.5 px-1" style={{ borderLeft: "1px solid var(--jms-border)" }}>
                {(allDayByDay[i] ?? []).map((e) => renderEventChip(e, true))}
              </div>
            ))}
          </div>
        ) : null}

        <div ref={gridScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative flex" style={{ height: 24 * HOUR_HEIGHT }}>
            <div style={{ width: TIME_COL_WIDTH }} className="relative flex-shrink-0">
              {GRID_HOURS.map((hour) => (
                <span
                  key={hour}
                  className="absolute right-1.5 text-[10px]"
                  style={{ top: hour * HOUR_HEIGHT - 6, color: "var(--jms-text-muted)" }}
                >
                  {formatHourLabel(hour)}
                </span>
              ))}
            </div>
            {days.map((day) => {
              const blocks = layoutDayColumn(day, events ?? []);
              const today = isSameDay(day, liveNow);
              return (
                <div
                  key={day.toDateString()}
                  onClick={(e) => handleGridSlotClick(day, e)}
                  className="relative min-w-0 flex-1 cursor-pointer"
                  style={{ borderLeft: "1px solid var(--jms-border)" }}
                >
                  {GRID_HOURS.map((hour) => (
                    <div key={hour} style={{ position: "absolute", top: hour * HOUR_HEIGHT, left: 0, right: 0, borderTop: "1px solid var(--jms-border)" }} />
                  ))}
                  {blocks.map(({ event, top, height, column, totalColumns }) => (
                    <button
                      key={event.id}
                      onClick={(e) => openPopover(event, e)}
                      className="absolute overflow-hidden rounded text-left text-[11px] font-medium text-white opacity-90 hover:z-10 hover:opacity-100"
                      style={{
                        top,
                        height,
                        left: `${(column / totalColumns) * 100}%`,
                        width: `${100 / totalColumns}%`,
                        backgroundColor: colorFor(event),
                        boxSizing: "border-box",
                        padding: "1px 4px",
                        border: "1px solid var(--jms-bg)",
                      }}
                    >
                      <span className="block truncate font-semibold">{event.title}</span>
                      {height >= 32 ? (
                        <span className="block truncate opacity-80">{formatEventTimeRange(event.start_at, event.end_at, false)}</span>
                      ) : null}
                    </button>
                  ))}
                  {today ? (
                    <div
                      className="pointer-events-none absolute left-0 right-0 z-20"
                      style={{ top: (minutesFromDayStart(startOfDay(day), liveNow) / 60) * HOUR_HEIGHT }}
                    >
                      <div style={{ height: 2, backgroundColor: "var(--jms-danger)" }} />
                      <div
                        style={{
                          position: "absolute",
                          left: -4,
                          top: -3,
                          width: 8,
                          height: 8,
                          borderRadius: 9999,
                          backgroundColor: "var(--jms-danger)",
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderDayView = () => renderTimeGrid([anchor]);

  const renderWeekView = () => {
    const weekStart = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    return renderTimeGrid(days);
  };

  const renderMonthView = () => {
    const gridDays = monthGridDays(startOfMonth(anchor));
    const today = new Date();
    return (
      <div className="flex h-full flex-col p-4">
        <h2 className="mb-3 flex-shrink-0 text-center text-base font-bold" style={{ color: "var(--jms-text)" }}>
          {MONTH_LABELS[anchor.getMonth()]} {anchor.getFullYear()}
        </h2>
        <div className="grid flex-shrink-0 grid-cols-7 pb-2" style={{ borderBottom: "1px solid var(--jms-border)" }}>
          {WEEKDAY_LABELS.map((label) => (
            <p key={label} className="text-center text-xs font-semibold" style={{ color: "var(--jms-text-muted)" }}>
              {label}
            </p>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-7 grid-rows-6">
          {gridDays.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const dayEvents = eventsOn(day);
            const isToday = isSameDay(day, today);
            return (
              <div
                key={day.toDateString()}
                className="flex min-h-0 flex-col overflow-hidden"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: isToday ? "var(--jms-accent-glow)" : undefined }}
              >
                <button
                  onClick={() => openDay(day)}
                  className="flex-shrink-0 px-1 pt-1 text-left"
                  onMouseEnter={(e) => {
                    if (!isToday) e.currentTarget.style.backgroundColor = "var(--jms-bg)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }}
                >
                  <span
                    className={`text-sm ${isToday ? "font-extrabold" : ""}`}
                    style={{ color: !inMonth ? "var(--jms-border)" : isToday ? "var(--jms-accent)" : "var(--jms-text)" }}
                  >
                    {day.getDate()}
                  </span>
                </button>
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden px-1 pb-1">
                  {dayEvents.slice(0, 3).map((e) => renderEventChip(e, true))}
                  {dayEvents.length > 3 ? (
                    <span className="pl-1.5 text-[10px]" style={{ color: "var(--jms-text-muted)" }}>
                      +{dayEvents.length - 3} more
                    </span>
                  ) : null}
                </div>
              </div>
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
              className="rounded-lg p-4 text-left"
              style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--jms-accent-glow)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "var(--jms-surface)";
              }}
            >
              <p className="font-bold" style={{ color: "var(--jms-text)" }}>
                {label}
              </p>
              <p className="text-xs" style={{ color: "var(--jms-text-muted)" }}>
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
    <div
      className={`flex h-full flex-col p-8 ${viewMode === "year" ? "overflow-y-auto" : "min-h-0"}`}
      style={{ fontFamily: "var(--jms-font)" }}
    >
      <div className="mb-4 flex flex-shrink-0 items-center justify-between">
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Calendar
        </h1>
        <ThemedButton onClick={() => openNewEvent()}>+ New event</ThemedButton>
      </div>

      <div
        className="mb-4 flex flex-shrink-0 items-center justify-between rounded-lg p-3"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
      >
        <div className="flex gap-2">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className="rounded-full border px-3 py-1.5 text-sm font-semibold"
              style={
                viewMode === mode
                  ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)" }
                  : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)" }
              }
            >
              {VIEW_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => shiftAnchor(-1)} className="text-xl font-bold" style={{ color: "var(--jms-accent)" }}>
            &lsaquo;
          </button>
          <button onClick={goToday} className="text-sm font-bold hover:underline" style={{ color: "var(--jms-text)" }}>
            {heading}
          </button>
          <button onClick={() => shiftAnchor(1)} className="text-xl font-bold" style={{ color: "var(--jms-accent)" }}>
            &rsaquo;
          </button>
        </div>
      </div>

      {actionError ? (
        <p className="mb-2 flex-shrink-0 text-sm" style={{ color: "var(--jms-danger)" }}>
          {actionError}
        </p>
      ) : null}

      <div
        className={`rounded-lg ${viewMode === "year" ? "flex-shrink-0" : "min-h-0 flex-1 overflow-hidden"}`}
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
      >
        {isLoading ? (
          <p className="p-6 text-sm" style={{ color: "var(--jms-text-muted)" }}>
            Loading...
          </p>
        ) : (
          <>
            {viewMode === "day" ? renderDayView() : null}
            {viewMode === "week" ? renderWeekView() : null}
            {viewMode === "month" ? renderMonthView() : null}
            {viewMode === "year" ? renderYearView() : null}
          </>
        )}
      </div>

      {popover ? (
        <CalendarEventPopover
          event={popover.event}
          color={colorFor(popover.event)}
          categoryLabel={
            { job: "Job", task: "Task", personal: "Personal (Google)", general: "General" }[categoryForEvent(popover.event)]
          }
          anchorRect={popover.anchorRect}
          onClose={() => setPopover(null)}
          onEdit={() => openEditEvent(popover.event)}
          onDelete={() => requestDelete(popover.event)}
        />
      ) : null}

      {editor ? (
        <CalendarEventEditor
          mode={editor.mode}
          event={editor.event}
          initialDate={editor.initialDate}
          jobCards={jobCards ?? []}
          tasks={tasks ?? []}
          technicians={technicians ?? []}
          categoryColors={colors}
          onClose={() => setEditor(null)}
          onSave={(payload, scope) => saveMutation.mutateAsync({ payload, scope })}
          onDeleteRequested={requestDelete}
        />
      ) : null}

      {deleteScopeTarget ? (
        <RecurrenceScopeDialog
          action="delete"
          onConfirm={(scope) => deleteMutation.mutate({ event: deleteScopeTarget, scope })}
          onCancel={() => setDeleteScopeTarget(null)}
        />
      ) : null}
    </div>
  );
}
