import type { Task, TaskQuadrant } from "@jmssaas/shared";

// Fixed, distinct quadrant colours - same "app-level, not tenant-configurable
// data" reasoning as NotesGraphView.tsx/B2BReferrals.tsx's colorForIndex
// (see components/notes/notesData.ts's NOTEBOOK_PALETTE): the CRT theme
// only exposes one active accent colour at a time, but each Eisenhower
// quadrant needs its own stable identity that survives an accent swap.
export const QUADRANT_COLORS: Record<Exclude<TaskQuadrant, "unsorted">, string> = {
  do_first: "#ff5a7a", // red - urgent & important, most critical
  schedule: "#4ac6ff", // blue - important, plan for it
  delegate: "#ffd23f", // amber - urgent, hand it off
  eliminate: "#8a8f98", // grey - neither, lowest visual weight
};
export const UNSORTED_COLOR = "#c78bff"; // violet - matches the hub's glow

export function quadrantColor(quadrant: TaskQuadrant): string {
  return quadrant === "unsorted" ? UNSORTED_COLOR : QUADRANT_COLORS[quadrant];
}

// Inverse of taskQuadrant() (packages/shared/src/tasks.ts) - the concrete
// is_urgent/is_important patch to apply when a task is moved (by drag or
// the Move-to menu, or the drawer's own quadrant picker) into a given
// quadrant. "unsorted" clears both back to null.
export function patchForQuadrant(quadrant: TaskQuadrant): Pick<Task, "is_urgent" | "is_important"> {
  switch (quadrant) {
    case "do_first":
      return { is_urgent: true, is_important: true };
    case "schedule":
      return { is_urgent: false, is_important: true };
    case "delegate":
      return { is_urgent: true, is_important: false };
    case "eliminate":
      return { is_urgent: false, is_important: false };
    case "unsorted":
    default:
      return { is_urgent: null, is_important: null };
  }
}

// Shared option list for every "move this task to a quadrant" control -
// the Matrix card's Move-to menu, the Unsorted tray, the drawer's quadrant
// picker, and the Job Card's lightweight classification select.
export const MOVE_TARGETS: { quadrant: TaskQuadrant; label: string }[] = [
  { quadrant: "do_first", label: "Do First" },
  { quadrant: "schedule", label: "Schedule" },
  { quadrant: "delegate", label: "Delegate" },
  { quadrant: "eliminate", label: "Eliminate" },
  { quadrant: "unsorted", label: "Unsorted" },
];
