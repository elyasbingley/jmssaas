import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { QUADRANT_META, taskQuadrant, type Profile, type Task, type TaskQuadrant } from "@jmssaas/shared";
import { ThemedButton } from "../theme/ThemedButton";
import { ThemedModal } from "../theme/ThemedModal";
import { ThemedSelectField } from "../theme/ThemedFormField";
import { assigneeLabel, isOverdue, toMap } from "./taskHelpers";
import { QUADRANT_COLORS, UNSORTED_COLOR, patchForQuadrant } from "./matrixHelpers";
import { MoveToMenu } from "./MoveToMenu";

// The Eisenhower Matrix - a client-side-only view mode on the unscoped
// "All Tasks" screen (see Tasks.tsx), not a value in the stored
// TaskProjectViewType enum, since the matrix cuts across every project the
// same way the existing unscoped List/Calendar already do. Cards are
// draggable (dnd-kit, same pattern as BoardView.tsx) between the four
// quadrant panels and the Unsorted hub; every card also carries a Move-to
// menu as a non-drag alternative. Quadrant is always derived via
// taskQuadrant() - is_urgent/is_important are the only source of truth,
// this view never stores its own notion of "which quadrant".

const VISIBLE_PER_QUADRANT = 6;

function AxisLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="flex items-center justify-center px-1 py-1 text-center font-bold uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)", ...style }}>
      {children}
    </div>
  );
}

function MatrixCard({
  task,
  quadrant,
  profilesById,
  onMove,
}: {
  task: Task;
  quadrant: TaskQuadrant;
  profilesById: Map<string, Profile>;
  onMove: (taskId: string, quadrant: TaskQuadrant) => void;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task:${task.id}`, data: { taskId: task.id } });
  const overdue = isOverdue(task);
  const assignee = assigneeLabel(task.assigned_to, profilesById);

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={() => !isDragging && navigate(`/tasks/${task.id}`)}
      className="cursor-grab rounded p-2"
      style={{
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        zIndex: isDragging ? 20 : undefined,
        border: overdue ? "1px solid var(--jms-danger)" : "1px solid var(--jms-border)",
        backgroundColor: "var(--jms-bg)",
        opacity: isDragging ? 0.7 : 1,
      }}
    >
      <p
        className="mb-1 truncate font-semibold"
        style={{ color: overdue ? "var(--jms-danger)" : "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        title={task.title}
      >
        {task.title}
      </p>
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate" style={{ color: overdue ? "var(--jms-danger)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          {overdue ? "Overdue" : task.due_date ?? ""}
          {assignee ? ` · ${assignee}` : ""}
        </span>
        <MoveToMenu current={quadrant} onMove={(q) => onMove(task.id, q)} />
      </div>
    </div>
  );
}

function QuadrantPanel({
  quadrant,
  tasks,
  profilesById,
  expanded,
  onToggleExpand,
  onMove,
}: {
  quadrant: Exclude<TaskQuadrant, "unsorted">;
  tasks: Task[];
  profilesById: Map<string, Profile>;
  expanded: boolean;
  onToggleExpand: () => void;
  onMove: (taskId: string, quadrant: TaskQuadrant) => void;
}) {
  const meta = QUADRANT_META[quadrant];
  const color = QUADRANT_COLORS[quadrant];
  const { setNodeRef, isOver } = useDroppable({ id: `quadrant:${quadrant}` });
  const visibleTasks = expanded ? tasks : tasks.slice(0, VISIBLE_PER_QUADRANT);
  const hiddenCount = tasks.length - visibleTasks.length;

  return (
    <div
      ref={setNodeRef}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded"
      style={{ border: `1px solid ${color}`, backgroundColor: "var(--jms-surface)", boxShadow: isOver ? `0 0 14px ${color}` : undefined }}
    >
      <div className="flex items-start justify-between gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${color}`, backgroundColor: "var(--jms-bg)" }}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }} />
            <span className="truncate font-bold uppercase tracking-widest" style={{ color, fontSize: "var(--jms-font-label)" }} title={meta.guidance}>
              {meta.label}
            </span>
            <span className="flex-shrink-0 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {tasks.length}
            </span>
          </div>
          <p className="truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {meta.subtitle}
          </p>
        </div>
        <button
          onClick={onToggleExpand}
          title={expanded ? "Collapse" : "Expand"}
          className="flex-shrink-0 rounded px-1.5 py-0.5 font-semibold"
          style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
        >
          {expanded ? "⤡" : "⤢"}
        </button>
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto p-2" style={expanded ? undefined : { maxHeight: 360 }}>
        {visibleTasks.map((t) => (
          <MatrixCard key={t.id} task={t} quadrant={quadrant} profilesById={profilesById} onMove={onMove} />
        ))}
        {tasks.length === 0 ? (
          <p className="p-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            No tasks
          </p>
        ) : null}
      </div>
      {hiddenCount > 0 ? (
        <button
          onClick={onToggleExpand}
          className="px-3 py-1.5 text-left font-semibold hover:opacity-80"
          style={{ color, borderTop: `1px solid ${color}`, fontSize: "var(--jms-font-label)" }}
        >
          +{hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}

function UnsortedHub({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: "quadrant:unsorted" });
  return (
    <button
      ref={setNodeRef}
      onClick={onOpen}
      title="Unsorted tasks"
      className="flex flex-col items-center justify-center rounded-full font-bold"
      style={{
        gridColumn: "2 / span 2",
        gridRow: "2 / span 2",
        justifySelf: "center",
        alignSelf: "center",
        zIndex: 10,
        width: 92,
        height: 92,
        backgroundColor: "var(--jms-bg)",
        border: `2px solid ${UNSORTED_COLOR}`,
        boxShadow: isOver ? `0 0 28px ${UNSORTED_COLOR}` : `0 0 14px ${UNSORTED_COLOR}`,
        color: UNSORTED_COLOR,
      }}
    >
      <span style={{ fontSize: "var(--jms-font-title)" }}>{count}</span>
      <span className="uppercase tracking-widest" style={{ fontSize: "9px" }}>
        Unsorted
      </span>
    </button>
  );
}

function DelegateAssigneePrompt({
  task,
  profiles,
  onAssign,
  onSkip,
}: {
  task: Task;
  profiles: Profile[];
  onAssign: (profileId: string) => void;
  onSkip: () => void;
}) {
  const [choice, setChoice] = useState("");
  return (
    <ThemedModal open onClose={onSkip} title="Assign this task?">
      <p className="mb-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
        &ldquo;{task.title}&rdquo; moved to Delegate but has no assignee yet. Who should this go to?
      </p>
      <ThemedSelectField
        label="Assignee"
        value={choice}
        onChange={(v) => setChoice(v)}
        placeholder="Choose someone"
        options={profiles.map((p) => ({ value: p.id, label: p.full_name }))}
      />
      <div className="flex justify-end gap-3">
        <button onClick={onSkip} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          Skip
        </button>
        <ThemedButton onClick={() => choice && onAssign(choice)} disabled={!choice}>
          Assign
        </ThemedButton>
      </div>
    </ThemedModal>
  );
}

export function MatrixView({
  tasks,
  profilesById,
  profiles,
  onUpdateTask,
}: {
  tasks: Task[];
  profilesById: Map<string, Profile>;
  profiles: Profile[];
  onUpdateTask: (taskId: string, patch: Partial<Task>) => void;
}) {
  const [showCompleted, setShowCompleted] = useState(false);
  const [expanded, setExpanded] = useState<Exclude<TaskQuadrant, "unsorted"> | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [assigneePromptTaskId, setAssigneePromptTaskId] = useState<string | null>(null);

  const visibleTasks = useMemo(() => (showCompleted ? tasks : tasks.filter((t) => t.status !== "done")), [tasks, showCompleted]);
  const tasksById = useMemo(() => toMap(visibleTasks), [visibleTasks]);

  const grouped = useMemo(() => {
    const byQuadrant: Record<TaskQuadrant, Task[]> = { do_first: [], schedule: [], delegate: [], eliminate: [], unsorted: [] };
    for (const t of visibleTasks) byQuadrant[taskQuadrant(t)].push(t);
    return byQuadrant;
  }, [visibleTasks]);

  const handleMove = (taskId: string, quadrant: TaskQuadrant) => {
    onUpdateTask(taskId, patchForQuadrant(quadrant));
    if (quadrant === "delegate") {
      const task = tasksById.get(taskId);
      if (task && !task.assigned_to) setAssigneePromptTaskId(taskId);
    }
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("quadrant:")) return;
    const quadrant = overId.slice("quadrant:".length) as TaskQuadrant;
    const taskId = (active.data.current as { taskId: string } | undefined)?.taskId;
    if (!taskId) return;
    handleMove(taskId, quadrant);
  };

  const colTemplate = expanded === "do_first" || expanded === "delegate" ? "2fr 1fr" : expanded === "schedule" || expanded === "eliminate" ? "1fr 2fr" : "1fr 1fr";
  const rowTemplate = expanded === "do_first" || expanded === "schedule" ? "2fr 1fr" : expanded === "delegate" || expanded === "eliminate" ? "1fr 2fr" : "1fr 1fr";

  const assigneePromptTask = assigneePromptTaskId ? tasksById.get(assigneePromptTaskId) : null;

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col gap-3">
        <label className="flex w-fit items-center gap-1.5 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show completed tasks
        </label>

        <div className="grid flex-1 gap-2" style={{ gridTemplateColumns: `110px ${colTemplate}`, gridTemplateRows: `auto ${rowTemplate}` }}>
          <div style={{ gridColumn: 1, gridRow: 1 }} />
          <AxisLabel style={{ gridColumn: 2, gridRow: 1 }}>Urgent</AxisLabel>
          <AxisLabel style={{ gridColumn: 3, gridRow: 1 }}>Not Urgent</AxisLabel>
          <AxisLabel style={{ gridColumn: 1, gridRow: 2 }}>Important</AxisLabel>
          <AxisLabel style={{ gridColumn: 1, gridRow: 3 }}>Not Important</AxisLabel>

          <div style={{ gridColumn: 2, gridRow: 2, minHeight: 0 }}>
            <QuadrantPanel
              quadrant="do_first"
              tasks={grouped.do_first}
              profilesById={profilesById}
              expanded={expanded === "do_first"}
              onToggleExpand={() => setExpanded((e) => (e === "do_first" ? null : "do_first"))}
              onMove={handleMove}
            />
          </div>
          <div style={{ gridColumn: 3, gridRow: 2, minHeight: 0 }}>
            <QuadrantPanel
              quadrant="schedule"
              tasks={grouped.schedule}
              profilesById={profilesById}
              expanded={expanded === "schedule"}
              onToggleExpand={() => setExpanded((e) => (e === "schedule" ? null : "schedule"))}
              onMove={handleMove}
            />
          </div>
          <div style={{ gridColumn: 2, gridRow: 3, minHeight: 0 }}>
            <QuadrantPanel
              quadrant="delegate"
              tasks={grouped.delegate}
              profilesById={profilesById}
              expanded={expanded === "delegate"}
              onToggleExpand={() => setExpanded((e) => (e === "delegate" ? null : "delegate"))}
              onMove={handleMove}
            />
          </div>
          <div style={{ gridColumn: 3, gridRow: 3, minHeight: 0 }}>
            <QuadrantPanel
              quadrant="eliminate"
              tasks={grouped.eliminate}
              profilesById={profilesById}
              expanded={expanded === "eliminate"}
              onToggleExpand={() => setExpanded((e) => (e === "eliminate" ? null : "eliminate"))}
              onMove={handleMove}
            />
          </div>

          <UnsortedHub count={grouped.unsorted.length} onOpen={() => setTrayOpen(true)} />
        </div>
      </div>

      <ThemedModal open={trayOpen} onClose={() => setTrayOpen(false)} title={`Unsorted (${grouped.unsorted.length})`}>
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
          {grouped.unsorted.map((t) => {
            const overdue = isOverdue(t);
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 rounded px-2.5 py-1.5"
                style={{ border: overdue ? "1px solid var(--jms-danger)" : "1px solid var(--jms-border)" }}
              >
                <span className="truncate" style={{ color: overdue ? "var(--jms-danger)" : "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {overdue ? "Overdue · " : ""}
                  {t.title}
                </span>
                <MoveToMenu current="unsorted" onMove={(q) => handleMove(t.id, q)} />
              </div>
            );
          })}
          {grouped.unsorted.length === 0 ? (
            <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Nothing unsorted.</p>
          ) : null}
        </div>
      </ThemedModal>

      {assigneePromptTask ? (
        <DelegateAssigneePrompt
          task={assigneePromptTask}
          profiles={profiles}
          onAssign={(profileId) => {
            onUpdateTask(assigneePromptTask.id, { assigned_to: profileId });
            setAssigneePromptTaskId(null);
          }}
          onSkip={() => setAssigneePromptTaskId(null)}
        />
      ) : null}
    </DndContext>
  );
}
