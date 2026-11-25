import { useMemo } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { JobLifecycleStage } from "@jmssaas/shared";
import { JobCardBody } from "./JobsPanel";
import type { DispatchEvent, DispatchJob, PropertyRow, Site } from "./data";
import { useDragState, type DragItem, type DropTarget } from "./drag";

// Stages: every job stage as a column, scrolling sideways. Drag a card to
// another column to move the job to that stage. Each card says how long
// the job has been sitting where it is.

type Places = { sites: Map<string, Site>; properties: Map<string, PropertyRow> } | undefined;
const CLOSED_DAYS = 30;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;

export function daysInStage(job: DispatchJob, now = Date.now()): number {
  const since = new Date(job.stage_changed_at ?? job.updated_at ?? job.created_at).getTime();
  return Math.max(0, Math.floor((now - since) / 86400000));
}
function ageLabel(days: number) {
  if (days === 0) return "Today";
  if (days === 1) return "1 day";
  if (days < 60) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

export function StagesView({
  jobs,
  events,
  stages,
  places,
  members,
  peopleById,
}: {
  jobs: DispatchJob[];
  events: DispatchEvent[];
  stages: JobLifecycleStage[];
  places: Places;
  members: Set<string> | undefined;
  peopleById: Map<string, string>;
}) {
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
  const byStage = useMemo(() => {
    const m = new Map<string, DispatchJob[]>();
    const cutoff = Date.now() - CLOSED_DAYS * 86400000;
    const closed = new Set(stages.filter((s) => s.is_closed).map((s) => s.id));
    for (const j of jobs) {
      if (!j.lifecycle_stage_id) continue;
      if (closed.has(j.lifecycle_stage_id) && new Date(j.stage_changed_at ?? j.updated_at).getTime() < cutoff) continue;
      const list = m.get(j.lifecycle_stage_id) ?? [];
      list.push(j);
      m.set(j.lifecycle_stage_id, list);
    }
    // Longest waiting first: those are the ones that need a nudge.
    for (const list of m.values()) list.sort((a, b) => (a.stage_changed_at ?? a.created_at).localeCompare(b.stage_changed_at ?? b.created_at));
    return m;
  }, [jobs, stages]);

  if (stages.length === 0) return <p className="p-6" style={muted}>No job stages set up yet. Add them in Settings, Job setup.</p>;

  return (
    <div className="flex h-full gap-3 overflow-x-auto overflow-y-hidden p-3" data-testid="stages-board" style={{ scrollSnapType: "x proximity" }}>
      {stages.map((stage) => (
        <StageColumn
          key={stage.id}
          stage={stage}
          jobs={byStage.get(stage.id) ?? []}
          places={places}
          members={members}
          peopleById={peopleById}
          nextBooking={nextBooking}
        />
      ))}
    </div>
  );
}

function StageColumn({
  stage,
  jobs,
  places,
  members,
  peopleById,
  nextBooking,
}: {
  stage: JobLifecycleStage;
  jobs: DispatchJob[];
  places: Places;
  members: Set<string> | undefined;
  peopleById: Map<string, string>;
  nextBooking: Map<string, DispatchEvent>;
}) {
  const target: DropTarget = { type: "stage", stageId: stage.id };
  const { setNodeRef, isOver } = useDroppable({ id: `stage|${stage.id}`, data: { target } });
  const { item } = useDragState();
  const draggingFromHere = item?.kind === "job" && item.job.lifecycle_stage_id === stage.id;
  const active = isOver && !!item && !draggingFromHere;
  const color = stage.color || "var(--jms-accent)";
  return (
    <section
      ref={setNodeRef}
      className="flex h-full w-[296px] shrink-0 flex-col rounded-md"
      style={{
        backgroundColor: active ? "color-mix(in srgb, var(--jms-accent) 8%, var(--jms-surface))" : "var(--jms-surface)",
        border: `1px ${active ? "dashed" : "solid"} ${active ? "var(--jms-accent)" : "var(--jms-border)"}`,
        scrollSnapAlign: "start",
        transition: "background-color 120ms, border-color 120ms",
      }}
      data-testid="stage-column"
      data-stage={stage.name}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--jms-border)", borderTop: `3px solid ${color}`, borderRadius: "6px 6px 0 0" }}>
        <h3 className="truncate font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          {stage.name}
        </h3>
        <span className="rounded-full px-2 font-semibold" style={{ backgroundColor: "var(--jms-bg)", ...muted }}>
          {jobs.length}
        </span>
      </header>
      {stage.is_closed ? <p className="px-3 pt-1" style={muted}>Last {CLOSED_DAYS} days</p> : null}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {jobs.length === 0 ? (
          <p className="py-6 text-center" style={muted}>
            {active ? "Drop to move here" : "No jobs"}
          </p>
        ) : null}
        {jobs.slice(0, 200).map((job) => (
          <KanbanCard
            key={job.id}
            job={job}
            stage={stage}
            places={places}
            member={!!members?.has(job.client_id)}
            tech={job.assigned_technician_id ? peopleById.get(job.assigned_technician_id) : undefined}
            booking={nextBooking.get(job.id)}
          />
        ))}
        {jobs.length > 200 ? <p style={muted}>+{jobs.length - 200} more</p> : null}
      </div>
    </section>
  );
}

function KanbanCard({
  job,
  stage,
  places,
  member,
  tech,
  booking,
}: {
  job: DispatchJob;
  stage: JobLifecycleStage;
  places: Places;
  member: boolean;
  tech: string | undefined;
  booking: DispatchEvent | undefined;
}) {
  const data: { item: DragItem } = { item: { kind: "job", job, width: 0 } };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `job|kanban|${job.id}`, data });
  const days = daysInStage(job);
  return (
    <JobCardBody
      job={job}
      places={places}
      member={member}
      stage={stage}
      tech={tech}
      booking={booking}
      dragging={isDragging}
      showStage={false}
      handle={{ ref: setNodeRef, ...listeners, ...attributes }}
      footer={<StageAge days={days} closed={stage.is_closed} />}
    />
  );
}

export function StageAge({ days, closed }: { days: number; closed: boolean }) {
  const stale = !closed && days >= 14;
  return (
    <p className="mt-1 font-semibold" style={{ color: stale ? "var(--jms-warning)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }} data-testid="stage-age">
      ⏱ {closed ? (days === 0 ? "Moved here today" : `Moved here ${ageLabel(days)} ago`) : days === 0 ? "Moved to this stage today" : `${ageLabel(days)} in this stage`}
    </p>
  );
}
