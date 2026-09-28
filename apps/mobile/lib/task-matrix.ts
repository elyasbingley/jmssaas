import { QUADRANT_META, QUADRANT_ORDER, type Task, type TaskQuadrant } from "@jmssaas/shared";

// Mobile-local Eisenhower Matrix helpers. taskQuadrant()/QUADRANT_META/
// QUADRANT_ORDER/suggestIsUrgent() live in packages/shared (shared with
// desktop) - everything here is mobile-UI-only glue that has no reason to
// be shared, so it stays local rather than growing the shared package.

// Desktop's apps/desktop/src/components/tasks/taskHelpers.ts has the
// canonical isOverdue() (due_date < today && status !== 'done'). There's no
// shared non-desktop-specific home for it yet, so this is the same
// one-liner logic duplicated for mobile rather than reaching into desktop's
// component tree from here.
export function isOverdue(task: Pick<Task, "due_date" | "status">): boolean {
  if (!task.due_date || task.status === "done") return false;
  return new Date(task.due_date) < new Date(new Date().toDateString());
}

// tenants.task_urgency_threshold_days isn't in the PowerSync local schema -
// tenants isn't a synced table at all (see e.g. calendar/index.tsx's and
// jobs/[id].tsx's own "tenants isn't a PowerSync table" comments), so it's
// only reachable online via useSupabaseFetch. This is the
// eisenhower_matrix migration's own column default, used as the fallback
// whenever that fetch hasn't resolved yet (offline, or still loading) so
// the due-date suggestion degrades gracefully instead of disappearing
// every time signal drops.
export const DEFAULT_TASK_URGENCY_THRESHOLD_DAYS = 2;

export interface MoveTarget {
  quadrant: TaskQuadrant;
  label: string;
  subtitle?: string;
}

// The "Move to..." sheet's options: the 4 real quadrants (from
// QUADRANT_META, in QUADRANT_ORDER) plus Unsorted, which isn't a quadrant
// with guidance copy of its own - it's the absence of classification - so
// it's appended here with just a label.
export const MOVE_TARGETS: MoveTarget[] = [
  // QUADRANT_ORDER is typed as plain TaskQuadrant[] (it's a general-purpose
  // export, not scoped to the 4 real quadrants), even though its runtime
  // values never include "unsorted" - QUADRANT_META itself proves that by
  // only having keys for the other 4, so this cast just tells TS what's
  // already true at runtime.
  ...(QUADRANT_ORDER as Exclude<TaskQuadrant, "unsorted">[]).map((quadrant) => ({
    quadrant,
    label: QUADRANT_META[quadrant].label,
    subtitle: QUADRANT_META[quadrant].subtitle,
  })),
  { quadrant: "unsorted" as TaskQuadrant, label: "Unsorted" },
];

export function quadrantLabel(quadrant: TaskQuadrant): string {
  return quadrant === "unsorted" ? "Unsorted" : QUADRANT_META[quadrant].label;
}

/** Boolean axis pair a raw SQL param list can use directly (null passes through as SQL NULL, true/false as 1/0 to match the is_milestone convention used elsewhere in this app). */
export function axisParam(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

// The inverse of taskQuadrant() - maps a target quadrant back to the
// is_urgent/is_important pair to write. "unsorted" clears both axes back to
// null (never classified), which is the only way back to Unsorted since the
// two axes are otherwise independent booleans.
export function axesForQuadrant(quadrant: TaskQuadrant): { is_urgent: boolean | null; is_important: boolean | null } {
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
