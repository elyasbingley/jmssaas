import { QUADRANT_META, type TaskQuadrant } from "@jmssaas/shared";
import { ThemedBadge } from "../theme/ThemedBadge";
import { quadrantColor } from "./matrixHelpers";

// Same outlined-pill convention as priority badges elsewhere in Tasks
// (see TaskCard.tsx's PRIORITY_COLOR_VAR usage of ThemedBadge's sibling
// markup), just with the fixed per-quadrant colour from matrixHelpers.ts
// instead of a theme token, since the quadrant's colour must stay legible
// and distinct regardless of the active accent preset.
export function QuadrantBadge({ quadrant }: { quadrant: TaskQuadrant }) {
  const label = quadrant === "unsorted" ? "Unsorted" : QUADRANT_META[quadrant].label;
  return <ThemedBadge label={label} color={quadrantColor(quadrant)} />;
}
