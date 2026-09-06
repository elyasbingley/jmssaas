import { useNavigate } from "react-router-dom";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { JobCard, Profile, Task, TaskSection } from "@jmssaas/shared";
import { TaskCard } from "./TaskCard";

// Kanban board - columns are a project's task_sections, cards are its
// tasks. Dropping a card onto a column (or a new position within one)
// updates section_id/position_order instantly, same drag interaction as
// Dispatch.tsx's job pills, just reposition-only (no resize).

function DraggableCard({
  task,
  allTasks,
  profilesById,
  jobCardsById,
}: {
  task: Task;
  allTasks: Task[];
  profilesById: Map<string, Profile>;
  jobCardsById: Map<string, JobCard>;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `task:${task.id}`, data: { taskId: task.id } });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={() => !isDragging && navigate(`/tasks/${task.id}`)}
      style={{ transform: transform ? CSS.Translate.toString(transform) : undefined, zIndex: isDragging ? 20 : undefined }}
      className={`mb-2 cursor-pointer rounded-lg border border-gray-300 bg-white p-3 shadow-sm hover:border-blue-400 ${
        isDragging ? "opacity-70" : ""
      }`}
    >
      <TaskCard task={task} allTasks={allTasks} profilesById={profilesById} jobCardsById={jobCardsById} />
    </div>
  );
}

function Column({
  section,
  tasks,
  allTasks,
  profilesById,
  jobCardsById,
}: {
  section: TaskSection;
  tasks: Task[];
  allTasks: Task[];
  profilesById: Map<string, Profile>;
  jobCardsById: Map<string, JobCard>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `section:${section.id}`, data: { sectionId: section.id } });

  return (
    <div className="flex w-72 flex-shrink-0 flex-col rounded-lg bg-gray-50">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <p className="text-sm font-bold text-gray-900">{section.name}</p>
        <span className="text-xs font-semibold text-gray-400">{tasks.length}</span>
      </div>
      <div ref={setNodeRef} className={`min-h-[4rem] flex-1 p-2 ${isOver ? "bg-blue-50" : ""}`}>
        {tasks.map((task) => (
          <DraggableCard key={task.id} task={task} allTasks={allTasks} profilesById={profilesById} jobCardsById={jobCardsById} />
        ))}
        {tasks.length === 0 ? <p className="p-2 text-xs text-gray-400">No tasks</p> : null}
      </div>
    </div>
  );
}

export function BoardView({
  sections,
  tasks,
  allTasks,
  profilesById,
  jobCardsById,
  onMoveTask,
}: {
  sections: TaskSection[];
  tasks: Task[];
  allTasks: Task[];
  profilesById: Map<string, Profile>;
  jobCardsById: Map<string, JobCard>;
  onMoveTask: (params: { taskId: string; sectionId: string; positionOrder: number }) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("section:")) return;
    const sectionId = overId.slice("section:".length);
    const taskId = (active.data.current as { taskId: string } | undefined)?.taskId;
    if (!taskId) return;

    const destinationTasks = tasks.filter((t) => t.section_id === sectionId && t.id !== taskId);
    const positionOrder = destinationTasks.length > 0 ? Math.max(...destinationTasks.map((t) => t.position_order)) + 1 : 0;
    onMoveTask({ taskId, sectionId, positionOrder });
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex h-full gap-3 overflow-x-auto pb-2">
        {sections.map((section) => (
          <Column
            key={section.id}
            section={section}
            tasks={tasks
              .filter((t) => t.section_id === section.id)
              .sort((a, b) => a.position_order - b.position_order)}
            allTasks={allTasks}
            profilesById={profilesById}
            jobCardsById={jobCardsById}
          />
        ))}
        {sections.length === 0 ? <p className="p-6 text-sm text-gray-500">Add a section to start this board.</p> : null}
      </div>
    </DndContext>
  );
}
