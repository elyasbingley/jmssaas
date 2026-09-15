import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { JobCard, Profile, Task, TaskPriority, TaskSection, TaskStatus } from "@jmssaas/shared";
import { assigneeLabel, isOverdue, jobBadgeLabel, PRIORITY_LABELS, PRIORITY_ORDER, subtaskProgress } from "./taskHelpers";

const STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };

interface Group {
  key: string;
  label: string;
  tasks: Task[];
}

// Grouped accordion - by section when a project is selected (task_sections
// are project-scoped, so there's nothing to group by otherwise), by
// priority when viewing All Tasks. Inline editing on title/assignee/due
// date/priority/status - no separate edit modal, matches the "inline
// editing" requirement directly rather than a click-through-to-drawer-only
// flow.
export function ListView({
  groupBy,
  sections,
  tasks,
  profiles,
  jobCardsById,
  onUpdateTask,
}: {
  groupBy: "section" | "priority";
  sections: TaskSection[];
  tasks: Task[];
  profiles: Profile[];
  jobCardsById: Map<string, JobCard>;
  onUpdateTask: (taskId: string, patch: Partial<Task>) => void;
}) {
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const topLevel = tasks.filter((t) => !t.parent_task_id);

  const groups: Group[] =
    groupBy === "section"
      ? sections.map((s) => ({ key: s.id, label: s.name, tasks: topLevel.filter((t) => t.section_id === s.id) }))
      : PRIORITY_ORDER.map((p) => ({ key: p, label: PRIORITY_LABELS[p], tasks: topLevel.filter((t) => t.priority === p) }));

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key} className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <button
            onClick={() => toggleCollapsed(group.key)}
            className="flex w-full items-center justify-between px-4 py-2 text-left"
            style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}
          >
            <span className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              {collapsed.has(group.key) ? "▸" : "▾"} {group.label}
            </span>
            <span className="font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {group.tasks.length}
            </span>
          </button>
          {!collapsed.has(group.key) ? (
            group.tasks.length === 0 ? (
              <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
                No tasks
              </p>
            ) : (
              <div>
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    allTasks={tasks}
                    profiles={profiles}
                    profilesById={profilesById}
                    jobCardsById={jobCardsById}
                    onUpdateTask={onUpdateTask}
                  />
                ))}
              </div>
            )
          ) : null}
        </div>
      ))}
      {groups.every((g) => g.tasks.length === 0) ? (
        <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          No tasks match your filters.
        </p>
      ) : null}
    </div>
  );
}

function TaskRow({
  task,
  allTasks,
  profiles,
  profilesById,
  jobCardsById,
  onUpdateTask,
  indent = false,
}: {
  task: Task;
  allTasks: Task[];
  profiles: Profile[];
  profilesById: Map<string, Profile>;
  jobCardsById: Map<string, JobCard>;
  onUpdateTask: (taskId: string, patch: Partial<Task>) => void;
  indent?: boolean;
}) {
  const navigate = useNavigate();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [subtasksOpen, setSubtasksOpen] = useState(false);

  const subtasks = allTasks.filter((t) => t.parent_task_id === task.id);
  const progress = subtaskProgress(task.id, allTasks);
  const overdue = isOverdue(task);
  const jobNumber = jobBadgeLabel(task.job_card_id, jobCardsById);

  const commitTitle = () => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft !== task.title) onUpdateTask(task.id, { title: titleDraft.trim() });
    else setTitleDraft(task.title);
  };

  return (
    <div
      className="jms-nav-link last:border-0"
      style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: indent ? "var(--jms-bg)" : undefined, paddingLeft: indent ? 32 : undefined }}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        {subtasks.length > 0 ? (
          <button onClick={() => setSubtasksOpen((v) => !v)} style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {subtasksOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-3" />
        )}

        <input
          type="checkbox"
          checked={task.status === "done"}
          onChange={(e) => onUpdateTask(task.id, { status: e.target.checked ? "done" : "todo" })}
          className="h-4 w-4 flex-shrink-0"
        />

        <div className="min-w-[10rem] flex-1">
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTitle();
                if (e.key === "Escape") {
                  setTitleDraft(task.title);
                  setEditingTitle(false);
                }
              }}
              className="w-full rounded border px-1.5 py-0.5"
              style={{ borderColor: "var(--jms-accent)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              onDoubleClick={(e) => e.stopPropagation()}
              className="text-left font-medium hover:underline"
              style={{ color: task.status === "done" ? "var(--jms-text-muted)" : "var(--jms-text)", textDecoration: task.status === "done" ? "line-through" : undefined, fontSize: "var(--jms-font-body)" }}
            >
              {task.is_milestone ? "🔶 " : ""}
              {task.title}
            </button>
          )}
          {progress ? (
            <span className="ml-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              {progress.done}/{progress.total} subtasks
            </span>
          ) : null}
          {jobNumber ? (
            <button
              onClick={() => navigate(`/jobs/${task.job_card_id}`)}
              className="ml-2 rounded-full border px-2 py-0.5 font-semibold hover:opacity-80"
              style={{ borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
            >
              Job {jobNumber}
            </button>
          ) : null}
        </div>

        <select
          value={task.assigned_to ?? ""}
          onChange={(e) => onUpdateTask(task.id, { assigned_to: e.target.value || null })}
          className="rounded border px-1.5 py-1"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
        >
          <option value="">Unassigned</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={task.due_date ?? ""}
          onChange={(e) => onUpdateTask(task.id, { due_date: e.target.value || null })}
          className="rounded border px-1.5 py-1"
          style={{
            backgroundColor: "var(--jms-bg)",
            borderColor: overdue ? "var(--jms-danger)" : "var(--jms-border)",
            color: overdue ? "var(--jms-danger)" : "var(--jms-text)",
            fontSize: "var(--jms-font-label)",
          }}
        />

        <select
          value={task.priority}
          onChange={(e) => onUpdateTask(task.id, { priority: e.target.value as TaskPriority })}
          className="rounded border px-1.5 py-1"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
        >
          {PRIORITY_ORDER.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>

        <select
          value={task.status}
          onChange={(e) => onUpdateTask(task.id, { status: e.target.value as TaskStatus })}
          className="rounded border px-1.5 py-1"
          style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
        >
          {(["todo", "in_progress", "done"] as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>

        <button
          onClick={() => navigate(`/tasks/${task.id}`)}
          className="font-semibold hover:underline"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
        >
          Open
        </button>
      </div>

      {subtasksOpen
        ? subtasks.map((sub) => (
            <TaskRow
              key={sub.id}
              task={sub}
              allTasks={allTasks}
              profiles={profiles}
              profilesById={profilesById}
              jobCardsById={jobCardsById}
              onUpdateTask={onUpdateTask}
              indent
            />
          ))
        : null}
    </div>
  );
}
