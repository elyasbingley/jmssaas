import { useNavigate } from "react-router-dom";
import type { JobCard, Profile, Task } from "@jmssaas/shared";
import { assigneeLabel, initials, isOverdue, jobBadgeLabel, PRIORITY_COLORS, PRIORITY_LABELS, subtaskProgress } from "./taskHelpers";

// Card body shared by Board and List views - title, milestone badge,
// priority tag, subtask progress, due date (red if overdue), assignee
// avatar, linked Job # badge. Board wraps this in a draggable container;
// List wraps it in a table-ish row - both just render this.
export function TaskCard({
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
  const overdue = isOverdue(task);
  const progress = subtaskProgress(task.id, allTasks);
  const assignee = assigneeLabel(task.assigned_to, profilesById);
  const jobNumber = jobBadgeLabel(task.job_card_id, jobCardsById);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">
          {task.is_milestone ? <span className="mr-1" title="Milestone">🔶</span> : null}
          {task.title}
        </p>
        {assignee ? (
          <span
            title={assignee}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gray-700 text-[10px] font-bold text-white"
          >
            {initials(assignee)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${PRIORITY_COLORS[task.priority]}`}>
          {PRIORITY_LABELS[task.priority]}
        </span>
        {progress ? (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
            {progress.done}/{progress.total}
          </span>
        ) : null}
        {jobNumber ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/jobs/${task.job_card_id}`);
            }}
            className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-200"
          >
            Job {jobNumber}
          </button>
        ) : null}
        {task.due_date ? (
          <span className={`text-[11px] font-semibold ${overdue ? "text-red-600" : "text-gray-500"}`}>
            {overdue ? "Overdue " : ""}
            {task.due_date}
          </span>
        ) : null}
      </div>
    </div>
  );
}
