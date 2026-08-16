import { useMemo, useState } from "react";
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
import { addDays, addMonths, formatEventTimeRange, isSameDay, monthGridDays, startOfMonth, startOfWeek } from "../lib/datetime";
import { pushCalendarEventDelete, pushCalendarEventUpsert } from "../lib/google-calendar-sync";
import { CalendarEventPopover } from "../components/CalendarEventPopover";
import { CalendarEventEditor, type CalendarEventSavePayload } from "../components/CalendarEventEditor";
import { RecurrenceScopeDialog, type RecurrenceEditScope } from "../components/RecurrenceScopeDialog";

type ViewMode = "day" | "week" | "month" | "year";
const VIEW_MODES: ViewMode[] = ["day", "week", "month", "year"];
const VIEW_MODE_LABELS: Record<ViewMode, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type CalendarEventRow = CalendarEvent & {
  job_cards: { id: string; title: string; assigned_technician_id: string | null } | null;
  tasks: { id: string; title: string } | null;
};

async function fetchEvents(): Promise<CalendarEventRow[]> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*, job_cards(id, title, assigned_technician_id), tasks(id, title)")
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
async function fetchJobCards(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*").order("title");
  if (error) throw error;
  return data as JobCard[];
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

  const renderEventChip = (event: CalendarEventRow, dense = false) => (
    <button
      key={event.id}
      onClick={(e) => openPopover(event, e)}
      style={{ borderLeftColor: colorFor(event) }}
      className={`block w-full truncate border-l-4 bg-gray-50 px-1.5 text-left text-xs text-gray-800 hover:bg-gray-100 ${dense ? "py-0.5" : "py-1"}`}
    >
      {event.title}
    </button>
  );

  const renderEventRow = (event: CalendarEventRow) => (
    <button
      key={event.id}
      onClick={(e) => openPopover(event, e)}
      style={{ borderLeftColor: colorFor(event) }}
      className="block w-full border-b border-l-4 border-gray-100 py-2 pl-2 text-left last:border-b-0 hover:bg-gray-50"
    >
      <p className="text-xs font-semibold text-blue-700">{formatEventTimeRange(event.start_at, event.end_at, event.all_day)}</p>
      <p className="text-sm font-medium text-gray-900">{event.title}</p>
    </button>
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
            <div key={day.toDateString()} className="rounded-lg border border-gray-200 p-2 text-left">
              <button onClick={() => openDay(day)} className="mb-1 block w-full text-left">
                <p className={`text-xs font-bold ${isSameDay(day, new Date()) ? "text-blue-700" : "text-gray-700"}`}>
                  {day.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
                </p>
              </button>
              {dayEvents.length === 0 ? (
                <p className="text-xs text-gray-400">No events</p>
              ) : (
                <div className="flex flex-col gap-0.5">{dayEvents.map((e) => renderEventChip(e, true))}</div>
              )}
            </div>
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
        <div className="grid flex-1 grid-cols-7 grid-rows-6">
          {gridDays.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const dayEvents = eventsOn(day);
            return (
              <div key={day.toDateString()} className="flex min-h-0 flex-col overflow-hidden border border-gray-100">
                <button onClick={() => openDay(day)} className="flex-shrink-0 px-1 pt-1 text-left hover:bg-gray-50">
                  <span
                    className={`text-sm ${!inMonth ? "text-gray-300" : isSameDay(day, today) ? "font-extrabold text-blue-700" : "text-gray-900"}`}
                  >
                    {day.getDate()}
                  </span>
                </button>
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden px-1 pb-1">
                  {dayEvents.slice(0, 3).map((e) => renderEventChip(e, true))}
                  {dayEvents.length > 3 ? <span className="pl-1.5 text-[10px] text-gray-400">+{dayEvents.length - 3} more</span> : null}
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
        <button
          onClick={() => openNewEvent()}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New event
        </button>
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

      {actionError ? <p className="mb-2 flex-shrink-0 text-sm text-red-600">{actionError}</p> : null}

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
