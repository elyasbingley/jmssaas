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
// quadrant sections and the Unsorted hub; every card also carries a Move-to
// menu as a non-drag alternative. Quadrant is always derived via
// taskQuadrant() - is_urgent/is_important are the only source of truth,
// this view never stores its own notion of "which quadrant".
//
// Layout: one continuous cross (a shared border-right/border-bottom on the
// 2x2 content area, not four separate boxed/bordered panels) with strong
// colour-underlined quadrant titles, matching the classic Eisenhower
// reference layout - deliberately not four floating cards with their own
// borders and background, which left uneven gaps and read as cluttered.

const VISIBLE_PER_QUADRANT = 6;

function AxisLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="flex items-center justify-center px-1 py-1.5 text-center font-bold uppercase tracking-widest" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)", ...style }}>
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
        backgroundColor: "var(--jms-surface)",
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

function QuadrantSection({
  quadrant,
  tasks,
  profilesById,
  expanded,
  onToggleExpand,
  onMove,
  dividerStyle,
  isBottomRow,
  isTopRow,
}: {
  quadrant: Exclude<TaskQuadrant, "unsorted">;
  tasks: Task[];
  profilesById: Map<string, Profile>;
  expanded: boolean;
  onToggleExpand: () => void;
  onMove: (taskId: string, quadrant: TaskQuadrant) => void;
  dividerStyle: React.CSSProperties;
  // The Unsorted hub sits pinned at the exact row2/row3 line (see
  // MatrixView's own comment on why) - a fixed-size circle straddling that
  // line equally above and below it. A bottom-row section's header starts
  // right at that same line, and a top-row section's "+N more" link can end
  // right at it too, so both get a little extra clearance on the edge
  // nearest the hub regardless of how little (or how much) content either
  // row actually has.
  isBottomRow?: boolean;
  isTopRow?: boolean;
}) {
  const meta = QUADRANT_META[quadrant];
  const color = QUADRANT_COLORS[quadrant];
  const { setNodeRef, isOver } = useDroppable({ id: `quadrant:${quadrant}` });
  const visibleTasks = expanded ? tasks : tasks.slice(0, VISIBLE_PER_QUADRANT);
  const hiddenCount = tasks.length - visibleTasks.length;

  return (
    <div
      ref={setNodeRef}
      // h-full matters here: the wrapping grid-item div (see MatrixView)
      // already stretches to the row's full height by CSS Grid's own
      // default (align-items: stretch), but this div is only that grid
      // item's *child*, not the grid item itself - without h-full it sizes
      // to its own content and stops there, so a short quadrant's border
      // hugs its short content instead of reaching the true row boundary.
      // That's what made a sparse quadrant look like a tight box while its
      // taller neighbour's divider lines trailed off mid-row.
      className="flex h-full min-h-0 min-w-0 flex-col px-4"
      style={{
        ...dividerStyle,
        paddingTop: isBottomRow ? 76 : 16,
        paddingBottom: isTopRow ? 56 : 16,
        backgroundColor: isOver ? `${color}14` : "transparent",
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span
              className="font-black uppercase tracking-wide"
              style={{ color, fontSize: "calc(var(--jms-font-title) + 2px)", borderBottom: `2px solid ${color}`, paddingBottom: 1 }}
              title={meta.guidance}
            >
              {meta.label}
            </span>
            <span className="font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {tasks.length}
            </span>
          </div>
          <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
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
      <div className="flex flex-col gap-1.5 overflow-y-auto" style={expanded ? undefined : { maxHeight: 320 }}>
        {visibleTasks.map((t) => (
          <MatrixCard key={t.id} task={t} quadrant={quadrant} profilesById={profilesById} onMove={onMove} />
        ))}
        {tasks.length === 0 ? (
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)", fontStyle: "italic" }}>No tasks</p>
        ) : null}
      </div>
      {hiddenCount > 0 ? (
        <button onClick={onToggleExpand} className="mt-1.5 text-left font-semibold hover:underline" style={{ color, fontSize: "var(--jms-font-label)" }}>
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
        // Sits in its own dedicated zero-size gutter row/column (see
        // MatrixView's grid below), not spanning the two real quadrant
        // rows/columns - centering across a span would put it at the
        // midpoint of their *combined* size, which drifts away from the
        // true dividing line the moment the two rows (or columns) hold
        // different amounts of content. A zero-size track's position is
        // exactly the line itself, so this stays pinned there regardless.
        gridColumn: 3,
        gridRow: 3,
        justifySelf: "center",
        alignSelf: "center",
        zIndex: 10,
        width: 72,
        height: 72,
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

  const assigneePromptTask = assigneePromptTaskId ? tasksById.get(assigneePromptTaskId) : null;

  // A single shared cross-divider across the 2x2 content area (border-right
  // on the left column, border-bottom on the top row) rather than each
  // quadrant carrying its own four-sided border - this is what makes it
  // read as one matrix with a "+" through the middle instead of four
  // separate floating boxes.
  const dividerColor = "var(--jms-border)";
  const doFirstDivider: React.CSSProperties = { borderRight: `1px solid ${dividerColor}`, borderBottom: `1px solid ${dividerColor}` };
  const scheduleDivider: React.CSSProperties = { borderBottom: `1px solid ${dividerColor}` };
  const delegateDivider: React.CSSProperties = { borderRight: `1px solid ${dividerColor}` };
  const eliminateDivider: React.CSSProperties = {};

  // Columns: label | left quadrant | 0px gutter (the hub lives here - see
  // its own comment) | right quadrant. Rows: label | top quadrant | 0px
  // gutter | bottom quadrant. Content rows/columns are sized to fit their
  // own tasks (never forced to split the full remaining page height or
  // width evenly) - that "1fr 1fr" of a flex-1 container was the actual
  // cause of the huge empty gap whenever one side had far fewer tasks than
  // the other, since equal fractions of a tall viewport stay tall
  // regardless of how little content fills them.
  const gridTemplateColumns = `88px ${colTemplate.split(" ")[0]} 0px ${colTemplate.split(" ")[1]}`;
  const gridTemplateRows = "auto minmax(160px, auto) 0px minmax(160px, auto)";

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col gap-3">
        <label className="flex w-fit items-center gap-1.5 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show completed tasks
        </label>

        <div className="grid" style={{ gridTemplateColumns, gridTemplateRows, border: `1px solid ${dividerColor}`, borderRadius: 4 }}>
          <div style={{ gridColumn: 1, gridRow: 1, borderRight: `1px solid ${dividerColor}`, borderBottom: `1px solid ${dividerColor}` }} />
          <AxisLabel style={{ gridColumn: 2, gridRow: 1, borderBottom: `1px solid ${dividerColor}` }}>Urgent</AxisLabel>
          <div style={{ gridColumn: 3, gridRow: 1, borderBottom: `1px solid ${dividerColor}` }} />
          <AxisLabel style={{ gridColumn: 4, gridRow: 1, borderBottom: `1px solid ${dividerColor}` }}>Not Urgent</AxisLabel>
          <AxisLabel style={{ gridColumn: 1, gridRow: 2, borderRight: `1px solid ${dividerColor}` }}>Important</AxisLabel>
          <div style={{ gridColumn: 1, gridRow: 3, borderRight: `1px solid ${dividerColor}` }} />
          <AxisLabel style={{ gridColumn: 1, gridRow: 4, borderRight: `1px solid ${dividerColor}` }}>Not Important</AxisLabel>

          <div style={{ gridColumn: 2, gridRow: 2, minHeight: 0 }}>
            <QuadrantSection
              quadrant="do_first"
              tasks={grouped.do_first}
              profilesById={profilesById}
              expanded={expanded === "do_first"}
              onToggleExpand={() => setExpanded((e) => (e === "do_first" ? null : "do_first"))}
              onMove={handleMove}
              dividerStyle={doFirstDivider}
              isTopRow
            />
          </div>
          <div style={{ gridColumn: 4, gridRow: 2, minHeight: 0 }}>
            <QuadrantSection
              quadrant="schedule"
              tasks={grouped.schedule}
              profilesById={profilesById}
              expanded={expanded === "schedule"}
              onToggleExpand={() => setExpanded((e) => (e === "schedule" ? null : "schedule"))}
              onMove={handleMove}
              dividerStyle={scheduleDivider}
              isTopRow
            />
          </div>
          <div style={{ gridColumn: 2, gridRow: 4, minHeight: 0 }}>
            <QuadrantSection
              quadrant="delegate"
              tasks={grouped.delegate}
              profilesById={profilesById}
              expanded={expanded === "delegate"}
              onToggleExpand={() => setExpanded((e) => (e === "delegate" ? null : "delegate"))}
              onMove={handleMove}
              dividerStyle={delegateDivider}
              isBottomRow
            />
          </div>
          <div style={{ gridColumn: 4, gridRow: 4, minHeight: 0 }}>
            <QuadrantSection
              quadrant="eliminate"
              tasks={grouped.eliminate}
              profilesById={profilesById}
              expanded={expanded === "eliminate"}
              onToggleExpand={() => setExpanded((e) => (e === "eliminate" ? null : "eliminate"))}
              onMove={handleMove}
              dividerStyle={eliminateDivider}
              isBottomRow
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
