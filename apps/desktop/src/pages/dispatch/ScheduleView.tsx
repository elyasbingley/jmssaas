import { useRef, useState, type ReactNode } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { JobLifecycleStage, Profile } from "@jmssaas/shared";
import type { DispatchEvent, DispatchJob } from "./data";
import {
  DAY_END_MIN,
  DAY_START_MIN,
  SNAP_MIN,
  WORK_END_MIN,
  WORK_START_MIN,
  addDaysKey,
  cellId,
  clamp,
  clockLabel,
  dateOfKey,
  dayKeyOf,
  eventMinutes,
  laneId,
  minutesOfDay,
  rangeLabel,
  snap,
  stackRows,
  useDragState,
  type DragItem,
  type DropTarget,
} from "./drag";

// The team's schedule: Day (one timeline per person), Staff 3 days (three
// timelines side by side), Week and 2 weeks (a cell per person per day),
// and Month (a calendar). Jobs are dropped on from the Jobs panel; bookings
// are dragged to move them (to another time, day or person) and their
// right edge dragged to change how long they take.

export type ScheduleMode = "day" | "3day" | "week" | "2week" | "month";
export const MODES: { key: ScheduleMode; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "3day", label: "Staff 3 days" },
  { key: "week", label: "Week by day" },
  { key: "2week", label: "2 weeks" },
  { key: "month", label: "Month" },
];

const SPAN = DAY_END_MIN - DAY_START_MIN;
const NAME_COL = 168;
const ROW_H = 34; // one booking row inside a lane
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

export interface ScheduleProps {
  mode: ScheduleMode;
  anchor: string; // day key
  people: Profile[];
  jobsById: Map<string, DispatchJob>;
  events: DispatchEvent[];
  stagesById: Map<string, JobLifecycleStage>;
  onOpenEvent: (e: DispatchEvent) => void;
  onResize: (e: DispatchEvent, minutes: number) => void;
}

interface Lane {
  techId: string | null;
  name: string;
}

function lanesFor(people: Profile[]): Lane[] {
  return [...people.map((p) => ({ techId: p.id, name: p.full_name || p.email || "Someone" })), { techId: null, name: "Unassigned" }];
}

function techOf(e: DispatchEvent, jobsById: Map<string, DispatchJob>): string | null {
  return (e.job_card_id ? jobsById.get(e.job_card_id)?.assigned_technician_id : null) ?? null;
}

export function visibleDays(mode: ScheduleMode, anchor: string): string[] {
  if (mode === "day") return [anchor];
  if (mode === "3day") return [0, 1, 2].map((i) => addDaysKey(anchor, i));
  if (mode === "week" || mode === "2week") {
    const d = dateOfKey(anchor);
    const monday = addDaysKey(anchor, -((d.getDay() + 6) % 7));
    return Array.from({ length: mode === "week" ? 7 : 14 }, (_, i) => addDaysKey(monday, i));
  }
  // Month: whole weeks covering the month.
  const d = dateOfKey(anchor);
  const first = dayKeyOf(new Date(d.getFullYear(), d.getMonth(), 1));
  const start = addDaysKey(first, -((dateOfKey(first).getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => addDaysKey(start, i));
}

export function ScheduleView(props: ScheduleProps) {
  const { mode } = props;
  if (mode === "day" || mode === "3day") return <TimelineGrid {...props} />;
  if (mode === "month") return <MonthGrid {...props} />;
  return <DayCellsGrid {...props} />;
}

// ---------------------------------------------------------------------------
// Timelines (Day, Staff 3 days)
// ---------------------------------------------------------------------------

function TimelineGrid({ mode, anchor, people, jobsById, events, stagesById, onOpenEvent, onResize }: ScheduleProps) {
  const days = visibleDays(mode, anchor);
  const lanes = lanesFor(people);
  const compact = mode === "3day";
  const hourStep = compact ? 2 : 1;
  const minDayWidth = compact ? 360 : 960;
  const today = dayKeyOf(new Date());

  return (
    <div className="h-full overflow-auto" data-testid="schedule-timeline">
      <div style={{ minWidth: NAME_COL + minDayWidth * days.length }}>
        <div className="sticky top-0 z-20 flex" style={{ backgroundColor: "var(--jms-surface)", borderBottom: "1px solid var(--jms-border)" }}>
          <div className="sticky left-0 z-30 shrink-0" style={{ width: NAME_COL, backgroundColor: "var(--jms-surface)", borderRight: "1px solid var(--jms-border)" }} />
          {days.map((day) => (
            <div key={day} className="min-w-0 flex-1" style={{ borderRight: "1px solid var(--jms-border)" }}>
              <p className="py-1 text-center font-semibold" style={{ color: day === today ? "var(--jms-accent)" : "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
                {dateOfKey(day).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" })}
              </p>
              <div className="relative h-6">
                {Array.from({ length: SPAN / 60 / hourStep + 1 }, (_, i) => DAY_START_MIN + i * 60 * hourStep).map((m) => (
                  <span key={m} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((m - DAY_START_MIN) / SPAN) * 100}%`, ...muted }}>
                    {m === DAY_END_MIN || m === DAY_START_MIN ? "" : clockLabel(m)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        {lanes.map((lane) => (
          <div key={lane.techId ?? "none"} className="flex" style={{ borderBottom: "1px solid var(--jms-border)" }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center gap-2 px-3"
              style={{ width: NAME_COL, backgroundColor: "var(--jms-surface)", borderRight: "1px solid var(--jms-border)" }}
            >
              <Avatar name={lane.name} muted={lane.techId === null} />
              <span className="truncate font-semibold" style={{ color: lane.techId ? "var(--jms-text)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                {lane.name}
              </span>
            </div>
            {days.map((day) => (
              <TimelineLane
                key={day}
                lane={lane}
                day={day}
                compact={compact}
                events={events.filter((e) => techOf(e, jobsById) === lane.techId && dayKeyOf(new Date(e.start_at)) === day)}
                jobsById={jobsById}
                stagesById={stagesById}
                onOpenEvent={onOpenEvent}
                onResize={onResize}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineLane({
  lane,
  day,
  compact,
  events,
  jobsById,
  stagesById,
  onOpenEvent,
  onResize,
}: {
  lane: Lane;
  day: string;
  compact: boolean;
  events: DispatchEvent[];
  jobsById: Map<string, DispatchJob>;
  stagesById: Map<string, JobLifecycleStage>;
  onOpenEvent: (e: DispatchEvent) => void;
  onResize: (e: DispatchEvent, minutes: number) => void;
}) {
  const id = laneId(lane.techId, day);
  const target: DropTarget = { type: "lane", techId: lane.techId, day, startMin: DAY_START_MIN, endMin: DAY_END_MIN };
  const { setNodeRef, isOver } = useDroppable({ id, data: { target } });
  const { item, preview } = useDragState();
  const laneRef = useRef<HTMLDivElement | null>(null);
  const placed = stackRows(events.map((e) => ({ e, start: minutesOfDay(e.start_at), end: minutesOfDay(e.start_at) + eventMinutes(e) })));
  const showPreview = preview && preview.targetId === id;
  // The drop box goes in the first row it fits without overlapping
  // anything (the booking being moved doesn't count), else a new row -
  // the same place it'll sit once dropped.
  let previewRow = 0;
  if (showPreview) {
    const movingId = item?.kind === "event" ? item.event.id : null;
    const end = preview.startMin + preview.minutes;
    const clash = (r: number) => placed.some((p) => p.row === r && p.item.e.id !== movingId && p.item.start < end && p.item.end > preview.startMin);
    while (clash(previewRow)) previewRow++;
  }
  const rows = Math.max(1, ...placed.map((p) => p.row + 1), showPreview ? previewRow + 1 : 0);
  const hourStep = compact ? 2 : 1;

  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        laneRef.current = el;
      }}
      className="relative min-w-0 flex-1"
      style={{
        // min-height, so every day's lane in a person's row stretches to
        // the tallest one.
        minHeight: rows * ROW_H + 16,
        transition: "min-height 120ms ease-out",
        borderRight: "1px solid var(--jms-border)",
        backgroundColor: isOver && item ? "color-mix(in srgb, var(--jms-accent) 6%, transparent)" : "transparent",
      }}
      data-testid="schedule-lane"
      data-lane={id}
    >
      {/* Outside working hours, and the hour lines */}
      <div className="pointer-events-none absolute inset-y-0 left-0" style={{ width: `${((WORK_START_MIN - DAY_START_MIN) / SPAN) * 100}%`, backgroundColor: "color-mix(in srgb, var(--jms-text-muted) 7%, transparent)" }} />
      <div className="pointer-events-none absolute inset-y-0 right-0" style={{ width: `${((DAY_END_MIN - WORK_END_MIN) / SPAN) * 100}%`, backgroundColor: "color-mix(in srgb, var(--jms-text-muted) 7%, transparent)" }} />
      {Array.from({ length: SPAN / 60 }, (_, i) => i).map((i) => (
        <div
          key={i}
          className="pointer-events-none absolute inset-y-0"
          style={{ left: `${((i * 60) / SPAN) * 100}%`, borderLeft: `1px ${i % hourStep === 0 ? "solid" : "dotted"} color-mix(in srgb, var(--jms-border) ${i % hourStep === 0 ? 100 : 50}%, transparent)` }}
        />
      ))}
      {placed.map(({ item: p, row }) => (
        <TimelineBlock
          key={p.e.id}
          event={p.e}
          job={p.e.job_card_id ? jobsById.get(p.e.job_card_id) : undefined}
          stage={p.e.job_card_id ? stagesById.get(jobsById.get(p.e.job_card_id)?.lifecycle_stage_id ?? "") : undefined}
          startMin={p.start}
          minutes={p.end - p.start}
          row={row}
          laneRef={laneRef}
          onOpen={onOpenEvent}
          onResize={onResize}
        />
      ))}
      {showPreview ? (
        <div
          className="pointer-events-none absolute z-20 flex flex-col justify-center overflow-hidden rounded-md px-2"
          style={{
            left: `${((clamp(preview.startMin, DAY_START_MIN, DAY_END_MIN) - DAY_START_MIN) / SPAN) * 100}%`,
            width: `${(Math.min(preview.minutes, DAY_END_MIN - preview.startMin) / SPAN) * 100}%`,
            top: 8 + previewRow * ROW_H,
            height: ROW_H - 4,
            border: "2px dashed var(--jms-accent)",
            backgroundColor: "color-mix(in srgb, var(--jms-accent) 26%, var(--jms-surface))",
            boxShadow: "0 6px 18px rgba(0,0,0,0.3)",
          }}
          data-testid="drop-preview"
        >
          <span className="truncate font-semibold leading-tight" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
            {heldTitle(item)}
          </span>
          <span className="whitespace-nowrap font-semibold leading-tight" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            {preview.label}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// "J123 · Client" for whatever is being dragged.
function heldTitle(item: DragItem | null): string {
  if (!item) return "";
  const job = item.kind === "job" ? item.job : item.job;
  if (!job) return item.kind === "event" ? item.event.title : "";
  return [job.number, job.clients?.name].filter(Boolean).join(" · ") || job.title;
}

function blockTitle(event: DispatchEvent, job: DispatchJob | undefined): { top: string; bottom: string } {
  if (!job) return { top: event.title, bottom: "" };
  return { top: [job.number, job.clients?.name].filter(Boolean).join(" · "), bottom: job.title };
}

function TimelineBlock({
  event,
  job,
  stage,
  startMin,
  minutes,
  row,
  laneRef,
  onOpen,
  onResize,
}: {
  event: DispatchEvent;
  job: DispatchJob | undefined;
  stage: JobLifecycleStage | undefined;
  startMin: number;
  minutes: number;
  row: number;
  laneRef: React.MutableRefObject<HTMLDivElement | null>;
  onOpen: (e: DispatchEvent) => void;
  onResize: (e: DispatchEvent, minutes: number) => void;
}) {
  const [resizeTo, setResizeTo] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const data: { item: DragItem } = { item: { kind: "event", event, job, width: 0, height: 0, grabOffsetPx: 0 } };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `event|${event.id}`, data, disabled: resizeTo !== null || event.id.startsWith("temp-") });
  const shown = resizeTo ?? minutes;
  const clippedStart = clamp(startMin, DAY_START_MIN, DAY_END_MIN);
  const clippedEnd = clamp(startMin + shown, DAY_START_MIN, DAY_END_MIN);
  const closed = !!stage?.is_closed;
  const { top, bottom } = blockTitle(event, job);

  // Right-edge drag to change the duration, in 15-minute steps.
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const lane = laneRef.current;
    if (!lane) return;
    const pxPerMin = lane.getBoundingClientRect().width / SPAN;
    const startX = e.clientX;
    let latest = minutes;
    const onMove = (ev: PointerEvent) => {
      latest = clamp(snap(minutes + (ev.clientX - startX) / pxPerMin), SNAP_MIN, DAY_END_MIN - startMin);
      setResizeTo(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizeTo(null);
      if (latest !== minutes) onResize(event, latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    setResizeTo(minutes);
  };

  if (clippedEnd <= clippedStart) return null;
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        ref.current = el;
      }}
      className="group absolute z-10 select-none overflow-hidden rounded-md"
      style={{
        left: `calc(${((clippedStart - DAY_START_MIN) / SPAN) * 100}% + 1px)`,
        width: `calc(${((clippedEnd - clippedStart) / SPAN) * 100}% - 2px)`,
        top: 8 + row * ROW_H,
        height: ROW_H - 4,
        backgroundColor: closed ? "color-mix(in srgb, var(--jms-text-muted) 18%, var(--jms-surface))" : "color-mix(in srgb, var(--jms-accent) 22%, var(--jms-surface))",
        borderLeft: `3px solid ${closed ? "var(--jms-text-muted)" : "var(--jms-accent)"}`,
        opacity: isDragging ? 0.3 : 1,
        boxShadow: resizeTo !== null ? "0 0 0 2px var(--jms-accent)" : undefined,
        transition: "box-shadow 120ms",
      }}
      title={`${top}\n${bottom}\n${rangeLabel(startMin, shown)}`}
      data-testid="booking"
    >
      <button
        {...listeners}
        {...attributes}
        onClick={() => onOpen(event)}
        className="flex h-full w-full cursor-grab flex-col justify-center px-2 text-left active:cursor-grabbing"
        aria-label={`Booking ${top}, ${rangeLabel(startMin, shown)}. Drag to move.`}
      >
        <span className="truncate font-semibold leading-tight" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
          {top}
        </span>
        <span className="truncate leading-tight" style={muted}>
          {resizeTo !== null ? rangeLabel(startMin, shown) : `${clockLabel(startMin)} ${bottom}`}
        </span>
      </button>
      <span
        onPointerDown={startResize}
        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100"
        style={{ backgroundColor: "color-mix(in srgb, var(--jms-accent) 60%, transparent)" }}
        aria-label="Drag to change how long it takes"
        role="separator"
        data-testid="resize-handle"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week by day / 2 weeks: a cell per person per day
// ---------------------------------------------------------------------------

function DayCellsGrid({ mode, anchor, people, jobsById, events, stagesById, onOpenEvent }: ScheduleProps) {
  const days = visibleDays(mode, anchor);
  const lanes = lanesFor(people);
  const today = dayKeyOf(new Date());
  const narrow = mode === "2week";
  return (
    <div className="h-full overflow-auto" data-testid="schedule-cells">
      <div style={{ minWidth: NAME_COL + days.length * (narrow ? 96 : 150) }}>
        <div className="sticky top-0 z-20 flex" style={{ backgroundColor: "var(--jms-surface)", borderBottom: "1px solid var(--jms-border)" }}>
          <div className="sticky left-0 z-30 shrink-0" style={{ width: NAME_COL, backgroundColor: "var(--jms-surface)", borderRight: "1px solid var(--jms-border)" }} />
          {days.map((day) => (
            <div key={day} className="min-w-0 flex-1 py-1.5 text-center font-semibold" style={{ borderRight: "1px solid var(--jms-border)", color: day === today ? "var(--jms-accent)" : "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
              {dateOfKey(day).toLocaleDateString("en-AU", narrow ? { weekday: "short", day: "numeric" } : { weekday: "short", day: "numeric", month: "short" })}
            </div>
          ))}
        </div>
        {lanes.map((lane) => (
          <div key={lane.techId ?? "none"} className="flex" style={{ borderBottom: "1px solid var(--jms-border)" }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center gap-2 px-3" style={{ width: NAME_COL, backgroundColor: "var(--jms-surface)", borderRight: "1px solid var(--jms-border)" }}>
              <Avatar name={lane.name} muted={lane.techId === null} />
              <span className="truncate font-semibold" style={{ color: lane.techId ? "var(--jms-text)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                {lane.name}
              </span>
            </div>
            {days.map((day) => (
              <DayCell
                key={day}
                techId={lane.techId}
                day={day}
                weekend={[0, 6].includes(dateOfKey(day).getDay())}
                events={events.filter((e) => techOf(e, jobsById) === lane.techId && dayKeyOf(new Date(e.start_at)) === day).sort((a, b) => a.start_at.localeCompare(b.start_at))}
                jobsById={jobsById}
                stagesById={stagesById}
                narrow={narrow}
                onOpenEvent={onOpenEvent}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayCell({
  techId,
  day,
  weekend,
  events,
  jobsById,
  stagesById,
  narrow,
  onOpenEvent,
  children,
}: {
  techId: string | null | undefined;
  day: string;
  weekend: boolean;
  events: DispatchEvent[];
  jobsById: Map<string, DispatchJob>;
  stagesById: Map<string, JobLifecycleStage>;
  narrow: boolean;
  onOpenEvent: (e: DispatchEvent) => void;
  children?: ReactNode;
}) {
  const id = cellId(techId, day);
  const target: DropTarget = { type: "cell", techId, day };
  const { setNodeRef, isOver } = useDroppable({ id, data: { target } });
  const { item, preview } = useDragState();
  const showPreview = preview && preview.targetId === id;
  return (
    <div
      ref={setNodeRef}
      className="min-w-0 flex-1 space-y-1 p-1"
      style={{
        minHeight: 64,
        borderRight: "1px solid var(--jms-border)",
        backgroundColor: isOver && item ? "color-mix(in srgb, var(--jms-accent) 10%, transparent)" : weekend ? "color-mix(in srgb, var(--jms-text-muted) 6%, transparent)" : "transparent",
        outline: isOver && item ? "2px dashed var(--jms-accent)" : undefined,
        outlineOffset: -2,
      }}
      data-testid="schedule-cell"
      data-cell={id}
    >
      {children}
      {events.map((e) => (
        <Chip key={e.id} event={e} job={e.job_card_id ? jobsById.get(e.job_card_id) : undefined} stage={stagesById.get(jobsById.get(e.job_card_id ?? "")?.lifecycle_stage_id ?? "")} narrow={narrow} onOpen={onOpenEvent} />
      ))}
      {showPreview ? (
        <div
          className="truncate rounded px-1.5 py-0.5 font-semibold"
          style={{ border: "2px dashed var(--jms-accent)", backgroundColor: "color-mix(in srgb, var(--jms-accent) 26%, var(--jms-surface))", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
          data-testid="drop-preview"
        >
          <span style={{ color: "var(--jms-accent)" }}>{preview.label.split(" - ")[0]}</span> {heldTitle(item)}
        </div>
      ) : null}
    </div>
  );
}

function Chip({ event, job, stage, narrow, onOpen, showTech }: { event: DispatchEvent; job: DispatchJob | undefined; stage: JobLifecycleStage | undefined; narrow: boolean; onOpen: (e: DispatchEvent) => void; showTech?: string }) {
  const data: { item: DragItem } = { item: { kind: "event", event, job, width: 0, height: 0, grabOffsetPx: 0 } };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `event|${event.id}`, data, disabled: event.id.startsWith("temp-") });
  const { top, bottom } = blockTitle(event, job);
  const closed = !!stage?.is_closed;
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onOpen(event)}
      className="block w-full cursor-grab select-none truncate rounded px-1.5 py-0.5 text-left active:cursor-grabbing"
      style={{
        backgroundColor: closed ? "color-mix(in srgb, var(--jms-text-muted) 18%, var(--jms-surface))" : "color-mix(in srgb, var(--jms-accent) 22%, var(--jms-surface))",
        borderLeft: `3px solid ${closed ? "var(--jms-text-muted)" : "var(--jms-accent)"}`,
        opacity: isDragging ? 0.3 : 1,
        color: "var(--jms-text)",
        fontSize: "var(--jms-font-label)",
      }}
      title={`${top}\n${bottom}\n${rangeLabel(minutesOfDay(event.start_at), eventMinutes(event))}`}
      data-testid="booking"
    >
      <span className="font-semibold">{clockLabel(minutesOfDay(event.start_at))}</span> {showTech ? <span style={{ color: "var(--jms-text-muted)" }}>{showTech} </span> : null}
      {narrow ? job?.clients?.name ?? top : top}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

function MonthGrid({ anchor, people, jobsById, events, stagesById, onOpenEvent }: ScheduleProps) {
  const days = visibleDays("month", anchor);
  const month = anchor.slice(0, 7);
  const today = dayKeyOf(new Date());
  const nameOf = new Map(people.map((p) => [p.id, initialsOf(p.full_name)]));
  return (
    <div className="h-full overflow-auto p-2" data-testid="schedule-month">
      <div className="grid grid-cols-7 gap-px" style={{ backgroundColor: "var(--jms-border)", border: "1px solid var(--jms-border)" }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-1 text-center font-semibold uppercase" style={{ backgroundColor: "var(--jms-surface)", ...muted }}>
            {d}
          </div>
        ))}
        {days.map((day) => {
          const dayEvents = events.filter((e) => dayKeyOf(new Date(e.start_at)) === day).sort((a, b) => a.start_at.localeCompare(b.start_at));
          return (
            <div key={day} style={{ backgroundColor: "var(--jms-bg)", opacity: day.slice(0, 7) === month ? 1 : 0.55 }}>
              <DayCell techId={undefined} day={day} weekend={[0, 6].includes(dateOfKey(day).getDay())} events={[]} jobsById={jobsById} stagesById={stagesById} narrow onOpenEvent={onOpenEvent}>
                <p className="px-1 font-semibold" style={{ color: day === today ? "var(--jms-accent)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {dateOfKey(day).getDate()}
                </p>
                {dayEvents.slice(0, 4).map((e) => {
                  const tech = techOf(e, jobsById);
                  return <Chip key={e.id} event={e} job={e.job_card_id ? jobsById.get(e.job_card_id) : undefined} stage={stagesById.get(jobsById.get(e.job_card_id ?? "")?.lifecycle_stage_id ?? "")} narrow onOpen={onOpenEvent} showTech={tech ? nameOf.get(tech) : "?"} />;
                })}
                {dayEvents.length > 4 ? (
                  <p className="px-1" style={muted}>
                    +{dayEvents.length - 4} more
                  </p>
                ) : null}
              </DayCell>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function initialsOf(name: string | null | undefined) {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function Avatar({ name, muted: dim = false, size = 28 }: { name: string; muted?: boolean; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        backgroundColor: dim ? "color-mix(in srgb, var(--jms-text-muted) 25%, transparent)" : "var(--jms-accent-glow)",
        color: dim ? "var(--jms-text-muted)" : "var(--jms-accent)",
        border: `1px solid ${dim ? "var(--jms-border)" : "var(--jms-accent)"}`,
      }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );
}
