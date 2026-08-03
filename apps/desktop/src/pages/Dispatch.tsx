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
import type { CalendarEvent, Client, JobCard, JobLifecycleStage, Profile } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { addDays, isSameDay } from "../lib/datetime";
import { formatClientAddress } from "../lib/format";

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
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "technician").order("full_name");
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

interface DragData {
  kind: "unassigned" | "event";
  jobId: string;
  eventId?: string;
  durationMinutes?: number;
}

function EventBlock({ event, dayStart }: { event: CalendarEventRow; dayStart: Date }) {
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
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !isDragging && navigate(`/jobs/${event.job_card_id}`)}
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        zIndex: isDragging ? 20 : 1,
      }}
      className={`absolute top-1 bottom-1 overflow-hidden rounded-md border border-blue-300 bg-blue-100 px-2 py-1 text-left shadow-sm hover:bg-blue-200 ${
        isDragging ? "opacity-70" : ""
      }`}
    >
      <p className="truncate text-xs font-bold text-blue-900">{formatTime(event.start_at)}</p>
      <p className="truncate text-xs font-semibold text-gray-900">{event.job_cards?.title ?? event.title}</p>
      <p className="truncate text-xs text-gray-600">{event.job_cards?.clients?.name}</p>
    </button>
  );
}

function TechnicianRow({ technician, events, dayStart }: { technician: Profile; events: CalendarEventRow[]; dayStart: Date }) {
  const { setNodeRef, isOver } = useDroppable({ id: `tech:${technician.id}`, data: { technicianId: technician.id } });

  return (
    <div className="flex border-b border-gray-100 last:border-0">
      <div className="w-40 flex-shrink-0 border-r border-gray-100 p-3">
        <p className="text-sm font-bold text-gray-900">{technician.full_name}</p>
        <p className="text-xs text-gray-400">{events.length} job{events.length === 1 ? "" : "s"}</p>
      </div>
      <div ref={setNodeRef} className={`relative h-16 flex-1 ${isOver ? "bg-blue-50" : ""}`}>
        {HOURS.slice(0, -1).map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 border-r border-gray-100"
            style={{ left: `${((h - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR)) * 100}%` }}
          />
        ))}
        {events.map((event) => (
          <EventBlock key={event.id} event={event} dayStart={dayStart} />
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
      className={`flex-shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left shadow-sm hover:bg-gray-50 ${
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

  const [dragError, setDragError] = useState<string | null>(null);

  // Jobs already in a closed stage (is_closed on job_lifecycle_stages - the
  // default Completed/Invoiced stages, or any custom stage an admin marks
  // the same way) are excluded since there's nothing left to dispatch -
  // this replaced a status !== 'completed' && status !== 'invoiced' check
  // when the status column was dropped (see the
  // job_status_lifecycle_consolidation migration).
  const unassignedJobs = useMemo(() => {
    if (!jobCards || !events || !stages) return [];
    const now = new Date();
    const scheduledJobIds = new Set(events.filter((e) => new Date(e.start_at) >= now).map((e) => e.job_card_id));
    const closedStageIds = new Set(stages.filter((s) => s.is_closed).map((s) => s.id));
    return jobCards.filter(
      (job) => !scheduledJobIds.has(job.id) && !closedStageIds.has(job.lifecycle_stage_id ?? "")
    );
  }, [jobCards, events, stages]);

  const eventsByTechnician = useMemo(() => {
    const map = new Map<string, CalendarEventRow[]>();
    if (!events) return map;
    for (const event of events) {
      if (!isSameDay(new Date(event.start_at), selectedDate)) continue;
      const techId = event.job_cards?.assigned_technician_id;
      if (!techId) continue;
      if (!map.has(techId)) map.set(techId, []);
      map.get(techId)!.push(event);
    }
    for (const list of map.values()) list.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    return map;
  }, [events, selectedDate]);

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

      const { error: eventError } = await supabase.from("calendar_events").insert({
        tenant_id: job.tenant_id,
        title: job.title,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        all_day: false,
        job_card_id: job.id,
        created_by: job.created_by,
      });
      if (eventError) throw eventError;

      const { error: jobError } = await supabase
        .from("job_cards")
        .update({ assigned_technician_id: params.technicianId })
        .eq("id", job.id);
      if (jobError) throw jobError;
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
    },
    onSuccess: invalidate,
    onError: (e) => setDragError(e instanceof Error ? e.message : "Failed to reschedule"),
  });

  // Dropping a scheduled event back onto the Unassigned shelf undoes the
  // dispatch - deletes the calendar_event and clears the job's technician,
  // the inverse of scheduleJob above.
  const unassignEvent = useMutation({
    mutationFn: async (eventId: string) => {
      const { error } = await supabase.from("calendar_events").delete().eq("id", eventId);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e) => setDragError(e instanceof Error ? e.message : "Failed to unassign"),
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
      if (data.kind === "event" && data.eventId) unassignEvent.mutate(data.eventId);
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

        <div
          ref={setUnassignedRef}
          className={`mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 ${isOverUnassigned ? "bg-blue-50" : ""}`}
        >
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">
            Unassigned jobs - drag onto a technician to dispatch
          </p>
          {unassignedJobs.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing waiting to be scheduled.</p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {unassignedJobs.map((job) => (
                <UnassignedJobPill key={job.id} job={job} />
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto rounded-lg border border-gray-200 bg-white">
          <div className="flex border-b border-gray-200 bg-gray-50">
            <div className="w-40 flex-shrink-0 border-r border-gray-100" />
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
              <TechnicianRow key={tech.id} technician={tech} events={eventsByTechnician.get(tech.id) ?? []} dayStart={dayStart} />
            ))
          )}
        </div>
      </div>
    </DndContext>
  );
}
