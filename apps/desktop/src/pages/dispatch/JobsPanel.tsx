import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { JobLifecycleStage } from "@jmssaas/shared";
import { fmtDay } from "../../components/AssetEditor";
import { jobAddress, jobSuburb, type DispatchEvent, type DispatchJob, type PropertyRow, type Site } from "./data";
import { useDragState, type DragItem, type DropTarget } from "./drag";

// The right-hand Jobs panel: jobs waiting to be booked (and the other
// lists the office looks through), each card draggable onto the schedule.

export type JobFilter = "unbooked" | "booked" | "recurring" | "open" | "completed";
const FILTERS: { key: JobFilter; label: string }[] = [
  { key: "unbooked", label: "To schedule" },
  { key: "recurring", label: "Recurring to book" },
  { key: "booked", label: "Booked" },
  { key: "open", label: "All open" },
  { key: "completed", label: "Completed" },
];

type Places = { sites: Map<string, Site>; properties: Map<string, PropertyRow> } | undefined;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

export function filterJobs(
  filter: JobFilter,
  jobs: DispatchJob[],
  events: DispatchEvent[],
  stagesById: Map<string, JobLifecycleStage>
): DispatchJob[] {
  const now = Date.now();
  // job -> when it's booked: its next booking, else its latest one.
  const next = new Map<string, number>();
  const last = new Map<string, number>();
  for (const e of events) {
    if (!e.job_card_id) continue;
    const t = new Date(e.start_at).getTime();
    const into = t >= now ? next : last;
    const prev = into.get(e.job_card_id);
    if (prev === undefined || (t >= now ? t < prev : t > prev)) into.set(e.job_card_id, t);
  }
  const booked = new Map(last);
  for (const [id, t] of next) booked.set(id, t);
  const closed = (j: DispatchJob) => !!(j.lifecycle_stage_id && stagesById.get(j.lifecycle_stage_id)?.is_closed);
  const isBooked = (j: DispatchJob) => booked.has(j.id) || !!j.scheduled_at;
  const fortnight = now - 14 * 86400000;
  switch (filter) {
    case "unbooked":
      return jobs.filter((j) => !closed(j) && !isBooked(j));
    case "recurring":
      return jobs.filter((j) => !closed(j) && !isBooked(j) && j.recurring_service_id).sort((a, b) => (a.recurring_due_on ?? "").localeCompare(b.recurring_due_on ?? ""));
    case "booked":
      return jobs.filter((j) => !closed(j) && booked.has(j.id)).sort((a, b) => booked.get(a.id)! - booked.get(b.id)!);
    case "open":
      return jobs.filter((j) => !closed(j));
    case "completed":
      return jobs.filter((j) => closed(j) && new Date(j.completed_at ?? j.stage_changed_at ?? j.updated_at).getTime() >= fortnight);
  }
}

export function JobsPanel({
  jobs,
  events,
  stagesById,
  places,
  members,
  peopleById,
  filter,
  onFilter,
  onClose,
  highlight,
  onHover,
}: {
  jobs: DispatchJob[];
  events: DispatchEvent[];
  stagesById: Map<string, JobLifecycleStage>;
  places: Places;
  members: Set<string> | undefined;
  peopleById: Map<string, string>;
  filter: JobFilter;
  onFilter: (f: JobFilter) => void;
  onClose: () => void;
  highlight?: string | null;
  onHover?: (jobId: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const panelTarget: DropTarget = { type: "panel" };
  const { setNodeRef, isOver } = useDroppable({ id: "panel", data: { target: panelTarget } });
  const { item } = useDragState();
  const unscheduling = item?.kind === "event";
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = filterJobs(filter, jobs, events, stagesById);
    if (q) {
      out = out.filter((j) =>
        [j.number, j.title, j.clients?.name, j.clients?.phone, jobAddress(j, places)].some((v) => v && String(v).toLowerCase().includes(q))
      );
    }
    // Members first (priority scheduling), then the oldest waiting.
    if (filter === "unbooked" || filter === "open") {
      out = [...out].sort((a, b) => {
        const am = members?.has(a.client_id) ? 0 : 1;
        const bm = members?.has(b.client_id) ? 0 : 1;
        return am - bm || a.created_at.localeCompare(b.created_at);
      });
    }
    return out;
  }, [filter, jobs, events, stagesById, search, places, members]);
  const nextBooking = useMemo(() => {
    const m = new Map<string, DispatchEvent>();
    const now = Date.now();
    for (const e of events) {
      if (!e.job_card_id || new Date(e.end_at).getTime() < now) continue;
      const prev = m.get(e.job_card_id);
      if (!prev || e.start_at < prev.start_at) m.set(e.job_card_id, e);
    }
    return m;
  }, [events]);

  return (
    <aside ref={setNodeRef} className="relative flex h-full w-[300px] shrink-0 flex-col" style={{ borderLeft: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="jobs-panel">
      {unscheduling ? (
        <div
          className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md p-4 text-center font-semibold"
          style={{
            border: `2px dashed ${isOver ? "var(--jms-danger)" : "var(--jms-border)"}`,
            backgroundColor: isOver ? "color-mix(in srgb, var(--jms-danger) 14%, var(--jms-surface))" : "color-mix(in srgb, var(--jms-surface) 85%, transparent)",
            color: isOver ? "var(--jms-danger)" : "var(--jms-text-muted)",
            fontSize: "var(--jms-font-body)",
            transition: "background-color 120ms, border-color 120ms",
          }}
          data-testid="unschedule-zone"
        >
          Drop here to take it off the schedule
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
          Jobs <span style={{ color: "var(--jms-text-muted)" }}>{list.length}</span>
        </h2>
        <button onClick={onClose} className="rounded px-1.5 hover:underline" style={muted} aria-label="Hide the jobs panel" title="Hide">
          Hide ›
        </button>
      </div>
      <div className="space-y-2 px-3 py-2" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        <select
          value={filter}
          onChange={(e) => onFilter(e.target.value as JobFilter)}
          className="w-full rounded border px-2 py-1.5"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          aria-label="Which jobs"
        >
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search jobs, clients, addresses"
          className="w-full rounded border px-2 py-1.5"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          aria-label="Search jobs"
        />
        {filter !== "completed" ? <p style={muted}>Drag a job onto someone's schedule to book it.</p> : null}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {list.length === 0 ? <p style={muted}>{search ? "No jobs match." : filter === "unbooked" ? "Every open job is booked." : "Nothing here."}</p> : null}
        {list.slice(0, 300).map((job) => (
          <PanelJobCard
            key={job.id}
            job={job}
            places={places}
            member={!!members?.has(job.client_id)}
            stage={job.lifecycle_stage_id ? stagesById.get(job.lifecycle_stage_id) : undefined}
            tech={job.assigned_technician_id ? peopleById.get(job.assigned_technician_id) : undefined}
            booking={nextBooking.get(job.id)}
            highlighted={highlight === job.id}
            onHover={onHover}
          />
        ))}
        {list.length > 300 ? <p style={muted}>Showing the first 300. Search to narrow it down.</p> : null}
      </div>
    </aside>
  );
}

function PanelJobCard({
  job,
  places,
  member,
  stage,
  tech,
  booking,
  highlighted,
  onHover,
}: {
  job: DispatchJob;
  places: Places;
  member: boolean;
  stage: JobLifecycleStage | undefined;
  tech: string | undefined;
  booking: DispatchEvent | undefined;
  highlighted: boolean;
  onHover?: (jobId: string | null) => void;
}) {
  const data: { item: DragItem } = { item: { kind: "job", job, width: 0 } };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `job|panel|${job.id}`, data, disabled: !!stage?.is_closed });
  return <JobCardBody job={job} places={places} member={member} stage={stage} tech={tech} booking={booking} highlighted={highlighted} dragging={isDragging} onHover={onHover} handle={{ ref: setNodeRef, ...listeners, ...attributes }} draggable={!stage?.is_closed} />;
}

// The card itself - shared by the panel, the Stages board and the drag
// overlay so what you pick up looks exactly like what follows the cursor.
export function JobCardBody({
  job,
  places,
  member,
  stage,
  tech,
  booking,
  highlighted,
  dragging,
  overlay,
  onHover,
  handle,
  draggable = true,
  showStage = true,
  footer,
}: {
  job: DispatchJob;
  places: Places;
  member?: boolean;
  stage?: JobLifecycleStage;
  tech?: string;
  booking?: DispatchEvent;
  highlighted?: boolean;
  dragging?: boolean;
  overlay?: boolean;
  onHover?: (jobId: string | null) => void;
  handle?: Record<string, unknown> & { ref?: (el: HTMLElement | null) => void };
  draggable?: boolean;
  showStage?: boolean;
  footer?: React.ReactNode;
}) {
  const address = jobAddress(job, places);
  const { ref, ...handleProps } = handle ?? {};
  return (
    <div
      ref={ref as ((el: HTMLDivElement | null) => void) | undefined}
      {...handleProps}
      onMouseEnter={() => onHover?.(job.id)}
      onMouseLeave={() => onHover?.(null)}
      className={`select-none rounded-md p-2.5 ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{
        backgroundColor: "var(--jms-bg)",
        borderStyle: "solid",
        borderWidth: "1px 1px 1px 3px",
        borderColor: `${highlighted || overlay ? "var(--jms-accent)" : "var(--jms-border)"} `.repeat(3) + (member ? "var(--jms-warning)" : "var(--jms-accent)"),
        opacity: dragging ? 0.35 : 1,
        boxShadow: overlay ? "0 12px 28px rgba(0,0,0,0.35), 0 0 0 1px var(--jms-accent)" : undefined,
        transform: overlay ? "rotate(-1.2deg)" : undefined,
        touchAction: "none",
      }}
      data-testid="job-card"
      data-job={job.id}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/jobs/${job.id}`}
          onPointerDown={(e) => e.stopPropagation()}
          className="font-semibold hover:underline"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          tabIndex={overlay ? -1 : undefined}
        >
          {job.number ?? "Job"}
        </Link>
        <span className="flex shrink-0 flex-wrap justify-end gap-1">
          {member ? <Badge color="var(--jms-warning)">Member</Badge> : null}
          {job.recurring_service_id ? <Badge color="var(--jms-accent)">🔁 {job.recurring_due_on ? fmtDay(job.recurring_due_on).replace(/ \d{4}$/, "") : "Recurring"}</Badge> : null}
        </span>
      </div>
      <p className="truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        {job.clients?.name ?? "No client"}
      </p>
      <p className="truncate" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
        {job.title}
      </p>
      {address ? (
        <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }} title={address}>
          📍 {jobSuburb(job, places) ?? address}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {showStage && stage ? <span>{stage.name}</span> : null}
        {tech ? <span>· {tech}</span> : null}
        {booking ? (
          <span style={{ color: "var(--jms-accent)" }}>
            · {new Date(booking.start_at).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
          </span>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded px-1.5 font-semibold" style={{ color, border: `1px solid ${color}`, fontSize: 11, lineHeight: "16px" }}>
      {children}
    </span>
  );
}
