import { useState } from "react";
import type { TaskQuadrant } from "@jmssaas/shared";
import { MOVE_TARGETS } from "./matrixHelpers";

// Non-drag alternative for reclassifying a task, present on every Matrix
// card (and the Unsorted tray) alongside drag-and-drop - dnd-kit alone
// isn't discoverable/accessible for everyone, per the brief. A small
// dropdown listing the 4 quadrants + Unsorted, same backdrop-to-close
// convention as ThemedModal.
export function MoveToMenu({ current, onMove }: { current: TaskQuadrant; onMove: (quadrant: TaskQuadrant) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded border px-2 py-0.5 font-semibold"
        style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
      >
        Move to &#9662;
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 z-30 mt-1 w-36 overflow-hidden rounded"
            style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 0 10px var(--jms-accent-glow)" }}
          >
            {MOVE_TARGETS.filter((t) => t.quadrant !== current).map((t) => (
              <button
                key={t.quadrant}
                onClick={() => {
                  setOpen(false);
                  onMove(t.quadrant);
                }}
                className="block w-full px-3 py-1.5 text-left font-semibold hover:opacity-80"
                style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
