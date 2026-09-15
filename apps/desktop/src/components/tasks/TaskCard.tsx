import { useNavigate } from "react-router-dom";
import type { JobCard, Profile, Task, TaskPriority } from "@jmssaas/shared";
import { assigneeLabel, initials, isOverdue, jobBadgeLabel, PRIORITY_LABELS, subtaskProgress } from "./taskHelpers";

// Priority colours read from the CRT theme tokens (not a fixed hex
// palette - like Quotes.tsx/Invoices.tsx's own STATUS_COLOR_VAR, task
// priority has no meaning that must survive an accent swap, so it's fine
// for these to shift with the tenant's chosen accent). Defined locally
// (rather than in taskHelpers.ts, which stays plain framework-agnostic
// logic) and duplicated in the other view components that need it.
const PRIORITY_COLOR_VAR: Record<TaskPriority, string> = {
  urgent: "var(--jms-danger)",
  high: "var(--jms-warning)",
  medium: "var(--jms-accent)",
  low: "var(--jms-text-muted)",
};

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
        <p className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
          {task.is_milestone ? <span className="mr-1" title="Milestone">🔶</span> : null}
          {task.title}
        </p>
        {assignee ? (
          <span
            title={assignee}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-bold"
            style={{ backgroundColor: "var(--jms-bg)", border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "10px" }}
          >
            {initials(assignee)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="rounded-full border px-2 py-0.5 font-semibold uppercase tracking-wide"
          style={{ borderColor: PRIORITY_COLOR_VAR[task.priority], color: PRIORITY_COLOR_VAR[task.priority], fontSize: "var(--jms-font-label)" }}
        >
          {PRIORITY_LABELS[task.priority]}
        </span>
        {progress ? (
          <span
            className="rounded-full border px-2 py-0.5 font-semibold"
            style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
          >
            {progress.done}/{progress.total}
          </span>
        ) : null}
        {jobNumber ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/jobs/${task.job_card_id}`);
            }}
            className="rounded-full border px-2 py-0.5 font-semibold hover:opacity-80"
            style={{ borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
          >
            Job {jobNumber}
          </button>
        ) : null}
        {task.due_date ? (
          <span
            className="font-semibold"
            style={{ color: overdue ? "var(--jms-danger)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
          >
            {overdue ? "Overdue " : ""}
            {task.due_date}
          </span>
        ) : null}
      </div>
    </div>
  );
}
