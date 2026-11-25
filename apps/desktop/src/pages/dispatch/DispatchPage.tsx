import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
  type Over,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { jobAddress, useDispatchData, useDispatchMutations, type DispatchEvent, type DispatchJob } from "./data";
import {
  DAY_END_MIN,
  DAY_START_MIN,
  DEFAULT_BOOKING_MIN,
  DragContext,
  addDaysKey,
  atMinutes,
  clamp,
  dateOfKey,
  dayKeyOf,
  eventMinutes,
  firstFreeSlot,
  minutesOfDay,
  rangeLabel,
  snap,
  type DragItem,
  type DropPreview,
  type DropTarget,
} from "./drag";
import { JobCardBody, JobsPanel, type JobFilter } from "./JobsPanel";
import { MODES, ScheduleView, visibleDays, type ScheduleMode } from "./ScheduleView";
import { StagesView } from "./StagesView";
import { TasksView } from "./TasksView";
import { RecurringView } from "./RecurringView";
import { MapView } from "./MapView";

// Dispatch: Map, Schedule, Stages, Tasks and Recurring, with the Jobs
// panel down the right. One DndContext covers the whole page so a job can
// be dragged from the panel onto the schedule (to book it) or between
// stage columns, and bookings can be dragged around the schedule.
//
// How the drag is kept precise: the card that follows the cursor is a
// DragOverlay portalled to <body> (so no scrolling panel clips it), the
// pointer position is read straight from pointer events rather than from
// dnd-kit's delta (which drifts when a panel scrolls mid-drag), and the
// lane under the pointer is measured fresh on every move. The time a drop
// will land on is worked out from the left edge of what you're holding,
// snapped to 15 minutes, and drawn in the lane as a dashed box with the
// times, so what you see is exactly what you get on release.

type View = "map" | "schedule" | "stages" | "tasks" | "recurring";
const VIEWS: { key: View; label: string }[] = [
  { key: "map", label: "Map" },
  { key: "schedule", label: "Schedule" },
  { key: "stages", label: "Stages" },
  { key: "tasks", label: "Tasks" },
  { key: "recurring", label: "Recurring" },
];
const SPAN = DAY_END_MIN - DAY_START_MIN;
const JOB_GRAB_X = 14; // a picked-up job sits just right of the cursor...
const JOB_GRAB_Y = 14; // ...and just below it, so the drop box stays in view

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window */
  }
}

// A picked-up job card is pinned to the cursor (rather than keeping the
// spot it was grabbed at), so it never hides the drop box it's aiming at.
const pinJobToCursor: Modifier = ({ active, activatorEvent, draggingNodeRect, transform }) => {
  const item = active?.data.current?.item as DragItem | undefined;
  if (item?.kind !== "job" || !activatorEvent || !draggingNodeRect) return transform;
  const at = getEventCoordinates(activatorEvent);
  if (!at) return transform;
  return { ...transform, x: transform.x + at.x - draggingNodeRect.left - JOB_GRAB_X, y: transform.y + at.y - draggingNodeRect.top + JOB_GRAB_Y };
};

export default function DispatchPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const viewKeys = VIEWS.map((v) => v.key);
  const urlView = params.get("view") as View | null;
  const view: View = urlView && viewKeys.includes(urlView) ? urlView : stored("jms.dispatch.view", viewKeys, "schedule");
  const [mode, setModeState] = useState<ScheduleMode>(() => stored("jms.dispatch.mode", MODES.map((m) => m.key), "day"));
  const [anchor, setAnchor] = useState(() => dayKeyOf(new Date()));
  const [panelOpen, setPanelOpen] = useState(() => stored("jms.dispatch.panel", ["open", "closed"] as const, "open") === "open");
  const [filter, setFilter] = useState<JobFilter>("unbooked");
  const [hover, setHover] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<DispatchEvent | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  const setView = (v: View) => {
    store("jms.dispatch.view", v);
    const next = new URLSearchParams(params);
    next.set("view", v);
    setParams(next, { replace: true });
  };
  const setMode = (m: ScheduleMode) => {
    store("jms.dispatch.mode", m);
    setModeState(m);
  };
  const togglePanel = (open: boolean) => {
    store("jms.dispatch.panel", open ? "open" : "closed");
    setPanelOpen(open);
  };

  const { jobs, events, people, stages, places, members } = useDispatchData();
  const { book, move, unbook, setStage } = useDispatchMutations();
  const jobList = jobs.data ?? [];
  const eventList = events.data ?? [];
  const peopleList = people.data ?? [];
  const jobsById = useMemo(() => new Map(jobList.map((j) => [j.id, j])), [jobList]);
  const stagesById = useMemo(() => new Map((stages.data ?? []).map((s) => [s.id, s])), [stages.data]);
  const peopleById = useMemo(() => new Map(peopleList.map((p) => [p.id, p.full_name || p.email || "Someone"])), [peopleList]);
  const loadError = jobs.error ?? events.error ?? people.error ?? stages.error;

  // Fill the window under the top bar (which can wrap onto two lines).
  const shell = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => shell.current && setHeight(Math.max(420, window.innerHeight - shell.current.getBoundingClientRect().top - window.scrollY));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const err = book.error ?? move.error ?? unbook.error ?? setStage.error;
    if (err) setToast({ text: getErrorMessage(err, "That didn't save. It's been put back."), error: true });
  }, [book.error, move.error, unbook.error, setStage.error]);

  // ---- Drag and drop -------------------------------------------------------
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [item, setItem] = useState<DragItem | null>(null);
  const [preview, setPreviewState] = useState<DropPreview | null>(null);
  const itemRef = useRef<DragItem | null>(null);
  const previewRef = useRef<DropPreview | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const grabX = useRef(0);
  const overRef = useRef<Over | null>(null);
  const lastDragEnd = useRef(0);

  const setPreview = useCallback((p: DropPreview | null) => {
    const prev = previewRef.current;
    if (prev === p || (prev && p && prev.targetId === p.targetId && prev.startMin === p.startMin && prev.minutes === p.minutes && prev.label === p.label)) return;
    previewRef.current = p;
    setPreviewState(p);
  }, []);

  const techOfJob = (job: DispatchJob | undefined) => job?.assigned_technician_id ?? null;

  const computePreview = useCallback(
    (over: Over | null) => {
      const it = itemRef.current;
      const target = over?.data.current?.target as DropTarget | undefined;
      if (!it || !over || !target || target.type === "stage" || target.type === "panel") return setPreview(null);
      const minutes = it.kind === "event" ? eventMinutes(it.event) : DEFAULT_BOOKING_MIN;
      if (target.type === "lane") {
        const el = document.querySelector<HTMLElement>(`[data-lane="${String(over.id)}"]`);
        if (!el) return setPreview(null);
        const rect = el.getBoundingClientRect();
        const leftPx = pointer.current.x - grabX.current;
        const raw = DAY_START_MIN + ((leftPx - rect.left) / rect.width) * SPAN;
        const startMin = clamp(snap(raw), DAY_START_MIN, Math.max(DAY_START_MIN, DAY_END_MIN - minutes));
        return setPreview({ targetId: String(over.id), day: target.day, techId: target.techId, startMin, minutes, label: rangeLabel(startMin, minutes) });
      }
      // A whole day (week, 2 weeks, month): a booking keeps its time; a new
      // job goes in that person's first free gap.
      let startMin: number;
      if (it.kind === "event") startMin = minutesOfDay(it.event.start_at);
      else {
        const tech = target.techId === undefined ? techOfJob(it.job) : target.techId;
        const dayEvents = eventList.filter((e) => dayKeyOf(new Date(e.start_at)) === target.day && techOfJob(jobsById.get(e.job_card_id ?? "")) === tech);
        startMin = firstFreeSlot(dayEvents, minutes);
      }
      setPreview({ targetId: String(over.id), day: target.day, techId: target.techId, startMin, minutes, label: rangeLabel(startMin, minutes) });
    },
    [eventList, jobsById, setPreview]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    },
    []
  );
  const endDrag = () => {
    window.removeEventListener("pointermove", onPointerMove, true);
    // dnd-kit also cancels on a plain click (no drag), so only a real drag counts.
    if (itemRef.current) lastDragEnd.current = Date.now();
    itemRef.current = null;
    overRef.current = null;
    previewRef.current = null;
    setItem(null);
    setPreviewState(null);
    document.body.style.cursor = "";
  };
  // Pointer-scrolled panels: re-measure the lane when anything scrolls.
  useEffect(() => {
    if (!item) return;
    const onScroll = () => computePreview(overRef.current);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [item, computePreview]);

  const onDragStart = (e: DragStartEvent) => {
    const base = e.active.data.current?.item as DragItem | undefined;
    if (!base) return;
    const at = getEventCoordinates(e.activatorEvent) ?? { x: 0, y: 0 };
    pointer.current = at;
    // Measure what was picked up directly: dnd-kit's own rect for it can
    // still be unset on the first frame of a drag.
    const source = (e.activatorEvent.target as Element | null)?.closest('[data-testid="booking"], [data-testid="job-card"]');
    const rect = source?.getBoundingClientRect() ?? e.active.rect.current.initial;
    let it: DragItem = base;
    if (base.kind === "event") {
      grabX.current = rect ? at.x - rect.left : 0;
      it = { ...base, width: rect?.width ?? 160, height: rect?.height ?? 30, grabOffsetPx: grabX.current };
    } else {
      grabX.current = JOB_GRAB_X;
      it = { ...base, width: rect?.width ?? 260 };
    }
    itemRef.current = it;
    setItem(it);
    window.addEventListener("pointermove", onPointerMove, true);
    document.body.style.cursor = "grabbing";
  };
  const onDragMove = (e: DragMoveEvent) => {
    overRef.current = e.over;
    computePreview(e.over);
  };
  const onDragEnd = (e: DragEndEvent) => {
    const it = itemRef.current;
    if (e.over) computePreview(e.over);
    const p = previewRef.current;
    const target = e.over?.data.current?.target as DropTarget | undefined;
    endDrag();
    if (!it || !target) return;

    if (target.type === "stage") {
      if (it.kind === "job" && it.job.lifecycle_stage_id !== target.stageId) {
        setStage.mutate({ jobId: it.job.id, stageId: target.stageId });
        setToast({ text: `${it.job.number ?? "Job"} moved to ${stagesById.get(target.stageId)?.name ?? "that stage"}` });
      }
      return;
    }
    if (target.type === "panel") {
      if (it.kind === "event") unbookEvent(it.event);
      return;
    }
    if (!p) return;
    const start = atMinutes(p.day, p.startMin);
    const who = (id: string | null) => (id ? peopleById.get(id) ?? "someone" : "Unassigned");
    const when = `${dateOfKey(p.day).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}, ${p.label}`;
    if (it.kind === "job") {
      const tech = target.techId === undefined ? techOfJob(it.job) : target.techId;
      book.mutate({ job: it.job, start, minutes: p.minutes, technicianId: tech, createdBy: profile?.id ?? null });
      setToast({ text: `Booked ${it.job.number ?? it.job.title} for ${who(tech)}, ${when}` });
    } else {
      const tech = target.techId; // undefined (month view) keeps whoever has it
      const sameTime = new Date(it.event.start_at).getTime() === start.getTime();
      const sameTech = tech === undefined || tech === techOfJob(it.job);
      if (sameTime && sameTech) return;
      move.mutate({ event: it.event, job: it.job, start, end: new Date(start.getTime() + p.minutes * 60000), technicianId: tech });
      setToast({ text: `Moved ${it.job?.number ?? it.event.title} to ${tech === undefined ? "" : `${who(tech)}, `}${when}` });
    }
  };

  const unbookEvent = (event: DispatchEvent) => {
    const others = eventList.some((e) => e.id !== event.id && e.job_card_id === event.job_card_id);
    unbook.mutate({ event, clearTech: !others });
    const job = event.job_card_id ? jobsById.get(event.job_card_id) : undefined;
    setToast({ text: `${job?.number ?? "Booking"} taken off the schedule${others ? "" : " - back in To schedule"}` });
  };

  const onResize = (event: DispatchEvent, minutes: number) => {
    const start = new Date(event.start_at);
    move.mutate({ event, job: event.job_card_id ? jobsById.get(event.job_card_id) : undefined, start, end: new Date(start.getTime() + minutes * 60000), technicianId: undefined });
  };

  // ---- Date navigation ----------------------------------------------------
  const stepDays = (dir: number) => {
    if (view === "schedule" && mode === "month") {
      const d = dateOfKey(anchor);
      setAnchor(dayKeyOf(new Date(d.getFullYear(), d.getMonth() + dir, 1)));
      return;
    }
    const n = view !== "schedule" ? 1 : mode === "3day" ? 3 : mode === "week" ? 7 : mode === "2week" ? 14 : 1;
    setAnchor(addDaysKey(anchor, dir * n));
  };
  const dateLabel = (() => {
    if (view === "map" || mode === "day") return dateOfKey(anchor).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (mode === "month") return dateOfKey(anchor).toLocaleDateString("en-AU", { month: "long", year: "numeric" });
    const days = visibleDays(mode, anchor);
    const f = (k: string) => dateOfKey(k).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
    return `${f(days[0]!)} - ${f(days[days.length - 1]!)}`;
  })();
  const showDates = view === "schedule" || view === "map";

  return (
    <DragContext.Provider value={{ item, preview }}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragOver={(e) => {
          overRef.current = e.over;
          computePreview(e.over);
        }}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
        autoScroll={{ threshold: { x: 0.08, y: 0.12 }, acceleration: 8 }}
        // Lanes grow a row to show where a drop will sit, so keep
        // measuring them during the drag, not just when it starts.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <div ref={shell} className="flex flex-col" style={{ height: height ?? "calc(100vh - 56px)", fontFamily: "var(--jms-font)" }} data-testid="dispatch">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
            <nav className="flex rounded-md p-0.5" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }} aria-label="Dispatch views">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  onClick={() => setView(v.key)}
                  className="rounded px-3 py-1 font-semibold"
                  style={{
                    fontSize: "var(--jms-font-label)",
                    color: view === v.key ? "var(--jms-bg)" : "var(--jms-text)",
                    backgroundColor: view === v.key ? "var(--jms-accent)" : "transparent",
                  }}
                  aria-current={view === v.key ? "page" : undefined}
                  data-testid={`view-${v.key}`}
                >
                  {v.label}
                </button>
              ))}
            </nav>
            {view === "schedule" ? (
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as ScheduleMode)}
                className="rounded border px-2 py-1"
                style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
                aria-label="Schedule layout"
                data-testid="schedule-mode"
              >
                {MODES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            ) : null}
            {showDates ? (
              <div className="flex items-center gap-1">
                <NavButton onClick={() => stepDays(-1)} label="Previous">
                  ‹
                </NavButton>
                <NavButton onClick={() => setAnchor(dayKeyOf(new Date()))} label="Today">
                  Today
                </NavButton>
                <NavButton onClick={() => stepDays(1)} label="Next">
                  ›
                </NavButton>
                <span className="ml-2 font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }} data-testid="date-label">
                  {dateLabel}
                </span>
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-3">
              {loadError ? <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>{getErrorMessage(loadError, "Couldn't load dispatch")}</span> : null}
              {!panelOpen ? (
                <button onClick={() => togglePanel(true)} className="rounded px-2 py-1 font-semibold" style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                  ‹ Jobs
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1" style={{ backgroundColor: "var(--jms-bg)" }}>
              {view === "schedule" ? (
                <ScheduleView
                  mode={mode}
                  anchor={anchor}
                  people={peopleList}
                  jobsById={jobsById}
                  events={eventList}
                  stagesById={stagesById}
                  onOpenEvent={(ev) => {
                    // A short drag ends with a click on the same block: that's a move, not "open".
                    if (Date.now() - lastDragEnd.current > 300) setOpenEvent(ev);
                  }}
                  onResize={onResize}
                />
              ) : null}
              {view === "map" ? <MapView day={anchor} jobs={jobList} events={eventList} people={peopleList} stagesById={stagesById} places={places.data} highlight={hover} /> : null}
              {view === "stages" ? <StagesView jobs={jobList} events={eventList} stages={stages.data ?? []} places={places.data} members={members.data} peopleById={peopleById} /> : null}
              {view === "tasks" ? <TasksView people={peopleList} /> : null}
              {view === "recurring" ? (
                <RecurringView
                  jobs={jobList}
                  events={eventList}
                  stagesById={stagesById}
                  onShowToBook={() => {
                    setFilter("recurring");
                    togglePanel(true);
                    setView("schedule");
                  }}
                />
              ) : null}
            </div>
            {panelOpen ? (
              <JobsPanel
                jobs={jobList}
                events={eventList}
                stagesById={stagesById}
                places={places.data}
                members={members.data}
                peopleById={peopleById}
                filter={filter}
                onFilter={setFilter}
                onClose={() => togglePanel(false)}
                highlight={hover}
                onHover={setHover}
              />
            ) : null}
          </div>
        </div>

        {createPortal(
          <DragOverlay dropAnimation={null} modifiers={[pinJobToCursor]} zIndex={1000}>
            {item ? (
              // Over the schedule the snapped drop box takes over (like
              // Google Calendar), so the floating copy fades out of its way.
              <div style={{ width: "100%", height: "100%", opacity: preview ? 0 : 1, transition: "opacity 90ms ease-out" }}>
                <DragGhost item={item} preview={preview} places={places.data} stage={item.kind === "job" && item.job.lifecycle_stage_id ? stagesById.get(item.job.lifecycle_stage_id) : undefined} />
              </div>
            ) : null}
          </DragOverlay>,
          document.body
        )}
      </DndContext>

      {openEvent ? (
        <BookingModal
          event={eventList.find((e) => e.id === openEvent.id) ?? openEvent}
          job={openEvent.job_card_id ? jobsById.get(openEvent.job_card_id) : undefined}
          address={openEvent.job_card_id && jobsById.get(openEvent.job_card_id) ? jobAddress(jobsById.get(openEvent.job_card_id)!, places.data) : null}
          tech={(() => {
            const id = openEvent.job_card_id ? jobsById.get(openEvent.job_card_id)?.assigned_technician_id : null;
            return id ? peopleById.get(id) ?? "Someone" : "Unassigned";
          })()}
          onClose={() => setOpenEvent(null)}
          onOpenJob={(id) => navigate(`/jobs/${id}`)}
          onRemove={(e) => {
            setOpenEvent(null);
            unbookEvent(e);
          }}
        />
      ) : null}

      {toast ? (
        <div
          className="fixed bottom-4 left-4 z-[60] max-w-md rounded-md px-4 py-2.5 font-semibold"
          style={{
            backgroundColor: "var(--jms-surface)",
            border: `1px solid ${toast.error ? "var(--jms-danger)" : "var(--jms-accent)"}`,
            color: toast.error ? "var(--jms-danger)" : "var(--jms-text)",
            fontSize: "var(--jms-font-body)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
          }}
          role="status"
          data-testid="dispatch-toast"
        >
          {toast.text}
        </div>
      ) : null}
    </DragContext.Provider>
  );
}

function NavButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded px-2.5 py-1 font-semibold" style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }} aria-label={label}>
      {children}
    </button>
  );
}

// What follows the cursor between drop targets: a booking is an exact
// copy of the block you picked up (same size, same grab point); a job is
// its card. Over the schedule it fades and the drop box shows instead.
function DragGhost({
  item,
  preview,
  places,
  stage,
}: {
  item: DragItem;
  preview: DropPreview | null;
  places: Parameters<typeof JobCardBody>[0]["places"];
  stage: Parameters<typeof JobCardBody>[0]["stage"];
}) {
  // Portalled outside the themed page, so it brings the theme font along.
  const lifted = { boxShadow: "0 14px 30px rgba(0,0,0,0.35), 0 0 0 1px var(--jms-accent)", pointerEvents: "none" as const, fontFamily: "var(--jms-font)" };
  if (item.kind === "event") {
    const top = [item.job?.number, item.job?.clients?.name].filter(Boolean).join(" · ") || item.event.title;
    return (
      <div
        className="flex flex-col justify-center overflow-hidden rounded-md px-2"
        style={{
          // The overlay wrapper is already exactly the size of the block.
          width: "100%",
          height: "100%",
          backgroundColor: "color-mix(in srgb, var(--jms-accent) 30%, var(--jms-surface))",
          borderLeft: "3px solid var(--jms-accent)",
          cursor: "grabbing",
          ...lifted,
        }}
        data-testid="drag-ghost"
      >
        <span className="truncate font-semibold leading-tight" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
          {top}
        </span>
        <span className="truncate font-semibold leading-tight" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          {preview ? preview.label : rangeLabel(minutesOfDay(item.event.start_at), eventMinutes(item.event))}
        </span>
      </div>
    );
  }
  return (
    <div style={{ width: item.width || 260, pointerEvents: "none", fontFamily: "var(--jms-font)" }} data-testid="drag-ghost">
      <JobCardBody job={item.job} places={places} stage={stage} overlay />
    </div>
  );
}

function BookingModal({
  event,
  job,
  address,
  tech,
  onClose,
  onOpenJob,
  onRemove,
}: {
  event: DispatchEvent;
  job: DispatchJob | undefined;
  address: string | null;
  tech: string;
  onClose: () => void;
  onOpenJob: (id: string) => void;
  onRemove: (e: DispatchEvent) => void;
}) {
  const start = new Date(event.start_at);
  const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
  return (
    <ThemedModal open onClose={onClose} title={job ? `${job.number ?? "Job"} · ${job.clients?.name ?? ""}` : event.title}>
      <div className="space-y-1.5" style={body}>
        {job ? <p className="font-semibold">{job.title}</p> : null}
        {address ? <p style={{ color: "var(--jms-text-muted)" }}>📍 {address}</p> : null}
        <p>
          🗓 {start.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}, {rangeLabel(minutesOfDay(event.start_at), eventMinutes(event))}
        </p>
        <p>👷 {tech}</p>
        <p className="pt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Drag the booking to move it, or drag its right edge to change how long it takes.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <button
          onClick={() => {
            if (window.confirm("Remove this booking? The job stays, ready to book again.")) onRemove(event);
          }}
          className="font-semibold hover:underline"
          style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}
          disabled={event.id.startsWith("temp-")}
        >
          Remove booking
        </button>
        <div className="flex gap-2">
          <ThemedButton variant="secondary" onClick={onClose}>
            Close
          </ThemedButton>
          {job ? <ThemedButton onClick={() => onOpenJob(job.id)}>Open job</ThemedButton> : null}
        </div>
      </div>
    </ThemedModal>
  );
}
