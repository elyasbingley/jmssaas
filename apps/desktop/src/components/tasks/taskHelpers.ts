import type { JobCard, Profile, Task, TaskDependency, TaskPriority } from "@jmssaas/shared";

// Shared read-only helpers for the Board/List/Calendar/Timeline views and
// the TaskDetail drawer - kept here rather than duplicated per-view since
// every view renders the same card/badge conventions.

export const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "medium", "low"];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-blue-100 text-blue-700",
  low: "bg-gray-100 text-gray-600",
};

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function isOverdue(task: Pick<Task, "due_date" | "status">): boolean {
  if (!task.due_date || task.status === "done") return false;
  return new Date(task.due_date) < new Date(new Date().toDateString());
}

// A task's own subtasks are ordinary rows with parent_task_id = task.id -
// no separate subtask table, so the rollup is just a filter + count over
// the same task list every view already has in memory.
export function subtaskProgress(taskId: string, allTasks: Task[]): { done: number; total: number } | null {
  const subtasks = allTasks.filter((t) => t.parent_task_id === taskId);
  if (subtasks.length === 0) return null;
  return { done: subtasks.filter((t) => t.status === "done").length, total: subtasks.length };
}

export function assigneeLabel(profileId: string | null, profilesById: Map<string, Profile>): string | null {
  if (!profileId) return null;
  return profilesById.get(profileId)?.full_name ?? null;
}

export function jobBadgeLabel(jobCardId: string | null, jobCardsById: Map<string, JobCard>): string | null {
  if (!jobCardId) return null;
  const job = jobCardsById.get(jobCardId);
  return job?.number ?? null;
}

export function toMap<T extends { id: string }>(rows: T[] | undefined): Map<string, T> {
  return new Map((rows ?? []).map((r) => [r.id, r]));
}

// Dependency guardrail - returns the still-incomplete tasks blocking
// `taskId`, or an empty array if it's clear to complete. Shared by every
// place a task can be marked done (the drawer's Complete button, and the
// Board/List views' own status controls) so the warning can't be
// bypassed just by completing a task from a different view.
export function unresolvedBlockers(taskId: string, dependencies: TaskDependency[], tasksById: Map<string, Task>): Task[] {
  const blockedBy = dependencies.filter((d) => d.dependent_task_id === taskId);
  return blockedBy.map((d) => tasksById.get(d.blocking_task_id)).filter((t): t is Task => !!t && t.status !== "done");
}

export function dependencyGuardrailMessage(blockers: Task[]): string {
  const names = blockers.map((t) => t.title).join(", ");
  return `This task is blocked by ${names}. Resolve dependencies first or override?`;
}
