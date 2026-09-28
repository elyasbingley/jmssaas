// Eisenhower Matrix helpers shared by desktop and mobile. The quadrant is a
// pure function of Task.is_urgent/is_important (see the eisenhower_matrix
// migration and the Task type's own comment) - deliberately not stored in
// Postgres, since deriving it needs no cross-row logic and keeping it
// computed means there's never a stale/out-of-sync quadrant to migrate.

import type { Task, TaskQuadrant } from "./types";

export function taskQuadrant(task: Pick<Task, "is_urgent" | "is_important">): TaskQuadrant {
  if (task.is_urgent === null || task.is_important === null) return "unsorted";
  if (task.is_urgent && task.is_important) return "do_first";
  if (!task.is_urgent && task.is_important) return "schedule";
  if (task.is_urgent && !task.is_important) return "delegate";
  return "eliminate";
}

export const QUADRANT_ORDER: TaskQuadrant[] = ["do_first", "schedule", "delegate", "eliminate"];

export interface QuadrantMeta {
  label: string;
  subtitle: string;
  /** Guidance text shown as an info affordance on the quadrant, per the brief. */
  guidance: string;
}

export const QUADRANT_META: Record<Exclude<TaskQuadrant, "unsorted">, QuadrantMeta> = {
  do_first: {
    label: "Do First",
    subtitle: "Urgent & Important",
    guidance: "Time-critical and it matters. Do this yourself, today.",
  },
  schedule: {
    label: "Schedule",
    subtitle: "Important, Not Urgent",
    guidance: "Matters, but it's not on fire. Block out time for it.",
  },
  delegate: {
    label: "Delegate",
    subtitle: "Urgent, Not Important",
    guidance: "Needs to happen soon but doesn't need to be you. Hand it off.",
  },
  eliminate: {
    label: "Eliminate",
    subtitle: "Not Urgent, Not Important",
    guidance: "Neither time-critical nor high-value. Question whether it needs doing at all.",
  },
};

/**
 * A due-date-driven *suggestion* for is_urgent - never applied automatically
 * (see the eisenhower_matrix migration's own comment: an explicit
 * is_urgent/is_important choice always wins and this never overwrites it).
 * Callers show this as a hint and let the user accept or dismiss it.
 * Returns null when there's no due date to suggest from.
 */
export function suggestIsUrgent(dueDate: string | null, thresholdDays: number): boolean | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysOut = Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  return daysOut <= thresholdDays;
}
