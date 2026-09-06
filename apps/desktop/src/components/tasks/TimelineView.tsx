import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task, TaskDependency } from "@jmssaas/shared";
import { addDays } from "../../lib/datetime";
import { PRIORITY_COLORS } from "./taskHelpers";

const DAY_WIDTH = 32;
const ROW_HEIGHT = 36;
const WINDOW_DAYS = 21;

function toLocalDate(dateStr: string): Date {
  const parts = dateStr.split("-").map(Number);
  return new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
}

// Horizontal bar chart - one row per task, bar spans start_date to
// due_date (a task with only one of the two renders a single-day marker
// at that date). SVG arrows overlay the grid connecting a blocking task's
// bar end to its dependent's bar start, using each row's known index for
// the y position and the shared date scale for x.
export function TimelineView({ tasks, dependencies }: { tasks: Task[]; dependencies: TaskDependency[] }) {
  const navigate = useNavigate();
  const [windowStart, setWindowStart] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3);
  });

  const scheduledTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.start_date || t.due_date)
        .sort((a, b) => toLocalDate(a.start_date ?? a.due_date!).getTime() - toLocalDate(b.start_date ?? b.due_date!).getTime()),
    [tasks]
  );

  const days = useMemo(() => Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(windowStart, i)), [windowStart]);
  const windowEnd = days[days.length - 1] ?? windowStart;

  const xForDate = (d: Date) => {
    const diffDays = Math.round((d.getTime() - windowStart.getTime()) / 86400000);
    return diffDays * DAY_WIDTH;
  };

  const rowIndexById = useMemo(() => new Map(scheduledTasks.map((t, i) => [t.id, i])), [scheduledTasks]);

  const arrows = useMemo(() => {
    return dependencies
      .map((dep) => {
        const blockingIdx = rowIndexById.get(dep.blocking_task_id);
        const dependentIdx = rowIndexById.get(dep.dependent_task_id);
        if (blockingIdx === undefined || dependentIdx === undefined) return null;
        const blocking = scheduledTasks[blockingIdx];
        const dependent = scheduledTasks[dependentIdx];
        if (!blocking || !dependent) return null;
        const blockingEnd = toLocalDate(blocking.due_date ?? blocking.start_date!);
        const dependentStart = toLocalDate(dependent.start_date ?? dependent.due_date!);
        return {
          key: dep.id,
          x1: xForDate(blockingEnd) + DAY_WIDTH,
          y1: blockingIdx * ROW_HEIGHT + ROW_HEIGHT / 2,
          x2: xForDate(dependentStart),
          y2: dependentIdx * ROW_HEIGHT + ROW_HEIGHT / 2,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [dependencies, rowIndexById, scheduledTasks, windowStart]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-3">
        <button onClick={() => setWindowStart((d) => addDays(d, -7))} className="text-xl font-bold text-blue-700">
          &lsaquo;
        </button>
        <button onClick={() => setWindowStart(addDays(new Date(), -3))} className="text-sm font-bold text-gray-900 hover:underline">
          {windowStart.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} - {windowEnd.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
        </button>
        <button onClick={() => setWindowStart((d) => addDays(d, 7))} className="text-xl font-bold text-blue-700">
          &rsaquo;
        </button>
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-gray-300 bg-white">
        <div className="flex">
          <div className="w-48 flex-shrink-0 border-r border-gray-300">
            <div className="border-b border-gray-300 bg-gray-50" style={{ height: 28 }} />
            {scheduledTasks.map((task) => (
              <button
                key={task.id}
                onClick={() => navigate(`/tasks/${task.id}`)}
                style={{ height: ROW_HEIGHT }}
                className="flex w-full items-center truncate border-b border-gray-100 px-2 text-left text-xs font-semibold text-gray-800 hover:bg-gray-50"
                title={task.title}
              >
                {task.is_milestone ? "🔶 " : ""}
                {task.title}
              </button>
            ))}
          </div>

          <div className="relative" style={{ width: WINDOW_DAYS * DAY_WIDTH }}>
            <div className="flex border-b border-gray-300 bg-gray-50" style={{ height: 28 }}>
              {days.map((d) => (
                <div key={d.toISOString()} className="flex-shrink-0 border-r border-gray-200 text-center text-[10px] text-gray-400" style={{ width: DAY_WIDTH }}>
                  {d.getDate()}
                </div>
              ))}
            </div>

            <div className="relative" style={{ height: scheduledTasks.length * ROW_HEIGHT }}>
              {days.map((d, i) => (
                <div
                  key={d.toISOString()}
                  className="absolute top-0 bottom-0 border-r border-gray-100"
                  style={{ left: i * DAY_WIDTH, width: DAY_WIDTH }}
                />
              ))}

              {scheduledTasks.map((task, i) => {
                const start = toLocalDate(task.start_date ?? task.due_date!);
                const end = toLocalDate(task.due_date ?? task.start_date!);
                const left = xForDate(start);
                const width = Math.max(xForDate(end) - left + DAY_WIDTH, DAY_WIDTH);
                return (
                  <button
                    key={task.id}
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    style={{ top: i * ROW_HEIGHT + 6, left, width, height: ROW_HEIGHT - 12 }}
                    className={`absolute overflow-hidden truncate rounded px-2 text-left text-[11px] font-semibold shadow-sm hover:opacity-80 ${PRIORITY_COLORS[task.priority]}`}
                  >
                    {task.title}
                  </button>
                );
              })}

              <svg className="pointer-events-none absolute inset-0 overflow-visible" width="100%" height="100%">
                <defs>
                  <marker id="timeline-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#9ca3af" />
                  </marker>
                </defs>
                {arrows.map((arrow) => (
                  <line
                    key={arrow.key}
                    x1={arrow.x1}
                    y1={arrow.y1}
                    x2={arrow.x2}
                    y2={arrow.y2}
                    stroke="#9ca3af"
                    strokeWidth={1.5}
                    markerEnd="url(#timeline-arrow)"
                  />
                ))}
              </svg>
            </div>
          </div>
        </div>

        {scheduledTasks.length === 0 ? <p className="p-6 text-sm text-gray-500">No tasks with a start or due date to plot.</p> : null}
      </div>
    </div>
  );
}
