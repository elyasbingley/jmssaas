import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { CalendarEvent, Client, JobCard, JobLifecycleStage, Profile, ServiceCategory } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { addDays, isSameDay } from "../lib/datetime";
import { formatClientAddress } from "../lib/format";
import { pushCalendarEventDelete, pushCalendarEventUpsert } from "../lib/google-calendar-sync";

// Dispatch board - the one screen the mobile app deliberately scoped down
// (see apps/mobile/app/schedule.tsx's own comment: a tap-to-assign list,
// because no desktop app existed yet to make a drag-and-drop timeline
// viable). This is that timeline, now that one does. calendar_events
// remains the single source of truth for "when is this job happening" -
// no parallel scheduling table, same as mobile's Schedule/Calendar views.
//
// Library choice: @dnd-kit/core, not react-big-calendar/FullCalendar's
// resource-timeline (a paid plugin) or a Google-Maps-Drawing-style
// toolbar. dnd-kit is unopinionated about layout, which is what a custom
// per-technician-lane Gantt view needs - the timeline grid, gridlines,
// and block positioning are plain CSS here, dnd-kit only handles pointer
// tracking and drop-target detection.
//
// Scope of this first pass: a single day view (prev/today/next), one row
// per technician, 07:00-19:00 in 15-minute snap increments. Not built:
// a week/multi-day timeline, resizing a block's duration by dragging its
// edge (only whole-block reposition), and recurring events - all
// reasonable follow-ups once this base interaction is proven out.

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 19;
const TOTAL_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const SNAP_MINUTES = 15;
const DEFAULT_DURATION_MINUTES = 60;
const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, i) => DAY_START_HOUR + i);

type JobCardRow = JobCard & { clients: Client | null };
type CalendarEventRow = CalendarEvent & { job_cards: JobCardRow | null };

async function fetchJobCards(): Promise<JobCardRow[]> {
  const { data, error } = await supabase.from("job_cards").select("*, clients(*)").order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobCardRow[];
}
// Any profile can be dispatched a job - not just role='technician' - so
// an admin who also does field work can assign jobs to themselves too.
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}
async function fetchEvents(): Promise<CalendarEventRow[]> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select("*, job_cards(*, clients(*))")
    .not("job_card_id", "is", null)
    .order("start_at", { ascending: true });
  if (error) throw error;
  return data as CalendarEventRow[];
}
async function fetchStages(): Promise<JobLifecycleStage[]> {
  const { data, error } = await supabase.from("job_lifecycle_stages").select("*").order("position");
  if (error) throw error;
  return data as JobLifecycleStage[];
}
async function fetchCategories(): Promise<ServiceCategory[]> {
  const { data, error } = await supabase.from("service_categories").select("*").order("name");
  if (error) throw error;
  return data as ServiceCategory[];
}

function dayStartFor(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), DAY_START_HOUR, 0, 0, 0);
}

function minutesFromDayStart(iso: string, dayStart: Date): number {
  return (new Date(iso).getTime() - dayStart.getTime()) / 60000;
}

function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

// Same three controls ServiceM8's own dispatch board search/filter offers
// (free-text search plus category/stage narrowing) - applied identically
// to the unassigned shelf and to which scheduled blocks show on the
// technician rows, so filtering narrows the whole board rather than just
// the jobs still waiting to be dispatched.
function jobMatchesFilters(
  job: JobCardRow,
  filters: { search: string; categoryId: string; stageId: string }
): boolean {
  if (filters.categoryId && job.service_category_id !== filters.categoryId) return false;
  if (filters.stageId && job.lifecycle_stage_id !== filters.stageId) return false;
  if (filters.search) {
    const haystack = `${job.title} ${job.clients?.name ?? ""}`.toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

interface DragData {
  kind: "unassigned" | "event";
  jobId: string;
  eventId?: string;
  durationMinutes?: number;
}

function EventBlock({
  event,
  dayStart,
  onRemove,
}: {
  event: CalendarEventRow;
  dayStart: Date;
  onRemove: (params: { eventId: string; jobId: string }) => void;
}) {
  const navigate = useNavigate();
  const data: DragData = {
    kind: "event",
    jobId: event.job_card_id!,
    eventId: event.id,
    durationMinutes: (new Date(event.end_at).getTime() - new Date(event.start_at).getTime()) / 60000,
  };
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `event:${event.id}`, data });

  const startMin = minutesFromDayStart(event.start_at, dayStart);
  const endMin = minutesFromDayStart(event.end_at, dayStart);
  const leftPct = clamp((startMin / TOTAL_MINUTES) * 100, 0, 100);
  const widthPct = clamp(((endMin - startMin) / TOTAL_MINUTES) * 100, 2, 100 - leftPct);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={() => !isDragging && navigate(`/jobs/${event.job_card_id}`)}
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        zIndex: isDragging ? 20 : 1,
      }}
      className={`group absolute top-1 bottom-1 overflow-hidden rounded-md border border-blue-300 bg-blue-100 px-2 py-1 text-left shadow-sm hover:bg-blue-200 ${
        isDragging ? "opacity-70" : ""
      }`}
    >
      <button
        type="button"
        title="Remove this booking"
        aria-label="Remove this booking"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove({ eventId: event.id, jobId: event.job_card_id! });
        }}
        className="absolute right-0.5 top-0.5 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-white text-xs font-bold leading-none text-gray-500 hover:bg-red-100 hover:text-red-600 group-hover:flex"
      >
        &times;
      </button>
      <p className="truncate text-xs font-bold text-blue-900">{formatTime(event.start_at)}</p>
      <p className="truncate text-xs font-semibold text-gray-900">{event.job_cards?.title ?? event.title}</p>
      <p className="truncate text-xs text-gray-600">{event.job_cards?.clients?.name}</p>
    </div>
  );
}

function TechnicianRow({
  technician,
  events,
  dayStart,
  onRemove,
}: {
  technician: Profile;
  events: CalendarEventRow[];
  dayStart: Date;
  onRemove: (params: { eventId: string; jobId: string }) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `tech:${technician.id}`, data: { technicianId: technician.id } });

  return (
    <div className="flex border-b border-gray-200 last:border-0">
      <div className="w-40 flex-shrink-0 border-r border-gray-200 p-3">
        <p className="text-sm font-bold text-gray-900">{technician.full_name}</p>
        <p className="text-xs text-gray-400">{events.length} job{events.length === 1 ? "" : "s"}</p>
      </div>
      <div ref={setNodeRef} className={`relative h-16 flex-1 ${isOver ? "bg-blue-50" : ""}`}>
        {HOURS.slice(0, -1).map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 border-r border-gray-200"
            style={{ left: `${((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}
          />
        ))}
        {events.map((event) => (
          <EventBlock key={event.id} event={event} dayStart={dayStart} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

function UnassignedJobPill({ job }: { job: JobCardRow }) {
  const navigate = useNavigate();
  const data: DragData = { kind: "unassigned", jobId: job.id };
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `unassigned:${job.id}`, data });

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !isDragging && navigate(`/jobs/${job.id}`)}
      style={{ transform: transform ? CSS.Translate.toString(transform) : undefined, zIndex: isDragging ? 20 : undefined }}
      className={`flex-shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left shadow-sm hover:bg-gray-50 ${
        isDragging ? "opacity-70" : ""
      }`}
    >
      <p className="text-sm font-semibold text-gray-900">{job.title}</p>
      <p className="text-xs text-gray-500">{job.clients?.name ?? "Unknown client"}</p>
    </button>
  );
}

export default function DispatchPage() {
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(new Date());
  const dayStart = useMemo(() => dayStartFor(selectedDate), [selectedDate]);

  const { data: jobCards } = useQuery({ queryKey: ["dispatch-job-cards"], queryFn: fetchJobCards });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });
  const { data: events } = useQuery({ queryKey: ["dispatch-events"], queryFn: fetchEvents });
  const { data: stages } = useQuery({ queryKey: ["job-lifecycle-stages"], queryFn: fetchStages });
  const { data: categories } = useQuery({ queryKey: ["service-categories"], queryFn: fetchCategories });

  const [dragError, setDragError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const trimmedSearch = search.trim();
  const hasActiveFilters = !!(trimmedSearch || categoryFilter || stageFilter);

  // Jobs already in a closed stage (is_closed on job_lifecycle_stages - the
  // default Completed/Invoiced stages, or any custom stage an admin marks
  // the same way) are excluded since there's nothing left to dispatch -
  // this replaced a status !== 'completed' && status !== 'invoiced' check
  // when the status column was dropped (see the
  // job_status_lifecycle_consolidation migration).
  //
  // "Scheduled" is compared against the start of today, not the exact
  // current moment - comparing against `now` meant a job scheduled for
  // later today at a clock time earlier than right now (e.g. dropping it
  // onto a 9am slot mid-afternoon) was already "in the past" the instant
  // it was created, so it never left the unassigned shelf (same bug fixed
  // in the mobile Schedule screen's own equivalent computation).
  const unassignedJobs = useMemo(() => {
    if (!jobCards || !events || !stages) return [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const scheduledJobIds = new Set(events.filter((e) => new Date(e.start_at) >= startOfToday).map((e) => e.job_card_id));
    const closedStageIds = new Set(stages.filter((s) => s.is_closed).map((s) => s.id));
    const filters = { search: trimmedSearch, categoryId: categoryFilter, stageId: stageFilter };
    return jobCards.filter(
      (job) =>
        !scheduledJobIds.has(job.id) && !closedStageIds.has(job.lifecycle_stage_id ?? "") && jobMatchesFilters(job, filters)
    );
  }, [jobCards, events, stages, trimmedSearch, categoryFilter, stageFilter]);

  const eventsByTechnician = useMemo(() => {
    const map = new Map<string, CalendarEventRow[]>();
    if (!events) return map;
    const filters = { search: trimmedSearch, categoryId: categoryFilter, stageId: stageFilter };
    for (const event of events) {
      if (!isSameDay(new Date(event.start_at), selectedDate)) continue;
      if (event.job_cards && !jobMatchesFilters(event.job_cards, filters)) continue;
      const techId = event.job_cards?.assigned_technician_id;
      if (!techId) continue;
      if (!map.has(techId)) map.set(techId, []);
      map.get(techId)!.push(event);
    }
    for (const list of map.values()) list.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    return map;
  }, [events, selectedDate, trimmedSearch, categoryFilter, stageFilter]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["dispatch-job-cards"] });
    queryClient.invalidateQueries({ queryKey: ["dispatch-events"] });
  };

  // Creates a calendar_event for a previously-unassigned job dropped onto a
  // technician's row, and dispatches that technician - same job-dispatch
  // semantics as apps/mobile/app/schedule.tsx's own "+ New event" flow.
  // This used to also bump a "new" job to "scheduled" - removed along with
  // the status column itself (see the job_status_lifecycle_consolidation
  // migration); there's no generic equivalent stage to bump to once a
  // tenant's pipeline is fully custom, so an admin now moves the stage
  // themselves if they want to.
  const scheduleJob = useMutation({
    mutationFn: async (params: { jobId: string; technicianId: string; startMinutes: number }) => {
      const job = (jobCards ?? []).find((j) => j.id === params.jobId);
      if (!job) throw new Error("Job not found");

      const start = new Date(dayStart.getTime() + params.startMinutes * 60000);
      const end = new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000);

      const { data: insertedEvent, error: eventError } = await supabase
        .from("calendar_events")
        .insert({
          tenant_id: job.tenant_id,
          title: job.title,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          all_day: false,
          job_card_id: job.id,
          created_by: job.created_by,
        })
        .select("id")
        .single();
      if (eventError) throw eventError;

      const { error: jobError } = await supabase
        .from("job_cards")
        .update({ assigned_technician_id: params.technicianId })
        .eq("id", job.id);
      if (jobError) throw jobError;

      // Must come after the job_cards write above lands, so the push
      // resolves the assignee's fresh (not stale) technician.
      await pushCalendarEventUpsert(insertedEvent.id);
    },
    onSuccess: invalidate,
    onError: (e) => setDragError(e instanceof Error ? e.message : "Failed to schedule job"),
  });

  // Reschedules and/or reassigns an existing event - preserves its
  // original duration, only the start time (and possibly technician)
  // changes.
  const rescheduleEvent = useMutation({
    mutationFn: async (params: { eventId: string; jobId: string; technicianId: string; startMinutes: number; durationMinutes: number }) => {
      const start = new Date(dayStart.getTime() + params.startMinutes * 60000);
      const end = new Date(start.getTime() + params.durationMinutes * 60000);

      const { error: eventError } = await supabase
        .from("calendar_events")
        .update({ start_at: start.toISOString(), end_at: end.toISOString() })
        .eq("id", params.eventId);
      if (eventError) throw eventError;

      const { error: jobError } = await supabase
        .from("job_cards")
        .update({ assigned_technician_id: params.technicianId })
        .eq("id", params.jobId);
      if (jobError) throw jobError;

      // Must come after the job_cards write above lands, so the push
      // resolves the assignee's fresh (not stale) technician - this is
      // exactly the reassignment case google-calendar-push's own comment
      // warns about calling too early.
      await pushCalendarEventUpsert(params.eventId);
    },
    onSuccess: invalidate,
    onError: (e) => setDragError(e instanceof Error ? e.message : "Failed to reschedule"),
  });

  // Removes a booking entirely - undoes the dispatch by deleting the
  // calendar_event and clearing the job's assigned_technician_id, the
  // inverse of scheduleJob above. Reachable two ways: dragging the block
  // back onto the Unassigned shelf, or the block's own "x" remove button
  // (added since the drag target alone wasn't discoverable enough - a
  // booking with no time left to reschedule to, or just wanting it gone,
  // shouldn't require finding the right drop zone).
  const unassignEvent = useMutation({
    mutationFn: async (params: { eventId: string; jobId: string }) => {
      // Capture these before the row is gone - nothing left to look them
      // up from afterward.
      const existing = (events ?? []).find((e) => e.id === params.eventId);
      const googleEventId = existing?.google_event_id;
      const googleConnectionId = existing?.google_calendar_connection_id;

      const { error: eventError } = await supabase.from("calendar_events").delete().eq("id", params.eventId);
      if (eventError) throw eventError;
      const { error: jobError } = await supabase
        .from("job_cards")
        .update({ assigned_technician_id: null })
        .eq("id", params.jobId);
      if (jobError) throw jobError;

      await pushCalendarEventDelete(params.eventId, googleEventId, googleConnectionId);
    },
    onSuccess: invalidate,
    onError: (e) => setDragError(e instanceof Error ? e.message : "Failed to remove booking"),
  });

  const { setNodeRef: setUnassignedRef, isOver: isOverUnassigned } = useDroppable({ id: "unassigned-shelf" });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (dragEvent: DragEndEvent) => {
    setDragError(null);
    const { active, over } = dragEvent;
    if (!over) return;
    const data = active.data.current as DragData | undefined;
    if (!data) return;

    if (over.id === "unassigned-shelf") {
      if (data.kind === "event" && data.eventId) unassignEvent.mutate({ eventId: data.eventId, jobId: data.jobId });
      return;
    }

    const overId = String(over.id);
    if (!overId.startsWith("tech:")) return;
    const technicianId = overId.slice("tech:".length);

    const activeRect = active.rect.current.translated;
    if (!activeRect) return;
    const relativeX = activeRect.left - over.rect.left;
    const percent = clamp(relativeX / over.rect.width, 0, 1);
    const startMinutes = clamp(snap(percent * TOTAL_MINUTES), 0, TOTAL_MINUTES - SNAP_MINUTES);

    if (data.kind === "unassigned") {
      scheduleJob.mutate({ jobId: data.jobId, technicianId, startMinutes });
    } else if (data.kind === "event" && data.eventId) {
      rescheduleEvent.mutate({
        eventId: data.eventId,
        jobId: data.jobId,
        technicianId,
        startMinutes,
        durationMinutes: data.durationMinutes ?? DEFAULT_DURATION_MINUTES,
      });
    }
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col p-8">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Dispatch</h1>
          <div className="flex items-center gap-3">
            <button onClick={() => setSelectedDate((d) => addDays(d, -1))} className="text-xl font-bold text-blue-700">
              &lsaquo;
            </button>
            <button onClick={() => setSelectedDate(new Date())} className="text-sm font-bold text-gray-900 hover:underline">
              {selectedDate.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}
            </button>
            <button onClick={() => setSelectedDate((d) => addDays(d, 1))} className="text-xl font-bold text-blue-700">
              &rsaquo;
            </button>
          </div>
        </div>

        {dragError ? <p className="mb-2 text-sm text-red-600">{dragError}</p> : null}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Search jobs or clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All categories</option>
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All stages</option>
            {(stages ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {hasActiveFilters ? (
            <button
              onClick={() => {
                setSearch("");
                setCategoryFilter("");
                setStageFilter("");
              }}
              className="text-sm font-semibold text-blue-700 hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        <div
          ref={setUnassignedRef}
          className={`mb-4 rounded-lg border border-gray-300 bg-gray-50 p-3 ${isOverUnassigned ? "bg-blue-50" : ""}`}
        >
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">
            Unassigned jobs - drag onto a technician to dispatch (drag a booking back here, or hover it for &times;, to
            remove it)
          </p>
          {unassignedJobs.length === 0 ? (
            <p className="text-sm text-gray-500">
              {hasActiveFilters ? "No unassigned jobs match your filters." : "Nothing waiting to be scheduled."}
            </p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {unassignedJobs.map((job) => (
                <UnassignedJobPill key={job.id} job={job} />
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto rounded-lg border border-gray-300 bg-white">
          <div className="flex border-b border-gray-300 bg-gray-50">
            <div className="w-40 flex-shrink-0 border-r border-gray-200" />
            <div className="relative flex-1" style={{ height: 24 }}>
              {HOURS.map((h) => (
                <span
                  key={h}
                  className="absolute -translate-x-1/2 text-xs text-gray-400"
                  style={{ left: `${((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}
                >
                  {h}:00
                </span>
              ))}
            </div>
          </div>

          {!technicians || technicians.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No technicians yet - add one from Team.</p>
          ) : (
            technicians.map((tech) => (
              <TechnicianRow
                key={tech.id}
                technician={tech}
                events={eventsByTechnician.get(tech.id) ?? []}
                dayStart={dayStart}
                onRemove={unassignEvent.mutate}
              />
            ))
          )}
        </div>
      </div>
    </DndContext>
  );
}
