import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task, TaskPriority } from "@jmssaas/shared";
import { addMonths, isSameDay, monthGridDays, startOfMonth } from "../../lib/datetime";
import { isOverdue } from "./taskHelpers";

// Priority colours read from the CRT theme tokens - see TaskCard.tsx's
// PRIORITY_COLOR_VAR comment for why this is duplicated locally rather
// than living in taskHelpers.ts.
const PRIORITY_COLOR_VAR: Record<TaskPriority, string> = {
  urgent: "var(--jms-danger)",
  high: "var(--jms-warning)",
  medium: "var(--jms-accent)",
  low: "var(--jms-text-muted)",
};

// Month grid plotting tasks by due_date - a task with a start_date too is
// also shown (dimmed) on its start day, so a multi-day task appears at
// both ends of its span without needing per-cell range-spanning bars
// (that's the Timeline view's job).
export function CalendarView({ tasks }: { tasks: Task[] }) {
  const navigate = useNavigate();
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(new Date()));
  const days = useMemo(() => monthGridDays(monthAnchor), [monthAnchor]);

  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      for (const dateStr of [task.due_date, task.start_date]) {
        if (!dateStr) continue;
        if (!map.has(dateStr)) map.set(dateStr, []);
        if (!map.get(dateStr)!.some((t) => t.id === task.id)) map.get(dateStr)!.push(task);
      }
    }
    return map;
  }, [tasks]);

  const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-3">
        <button onClick={() => setMonthAnchor((d) => addMonths(d, -1))} className="text-xl font-bold" style={{ color: "var(--jms-accent)" }}>
          &lsaquo;
        </button>
        <button
          onClick={() => setMonthAnchor(startOfMonth(new Date()))}
          className="font-bold hover:underline"
          style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          {monthAnchor.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}
        </button>
        <button onClick={() => setMonthAnchor((d) => addMonths(d, 1))} className="text-xl font-bold" style={{ color: "var(--jms-accent)" }}>
          &rsaquo;
        </button>
      </div>

      <div
        className="grid grid-cols-7 gap-px overflow-hidden rounded"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-border)", fontSize: "var(--jms-font-label)" }}
      >
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-2 py-1.5 text-center font-bold" style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)" }}>
            {d}
          </div>
        ))}
        {days.map((day) => {
          const inMonth = day.getMonth() === monthAnchor.getMonth();
          const today = isSameDay(day, new Date());
          const dayTasks = tasksByDate.get(dateKey(day)) ?? [];
          return (
            <div
              key={day.toISOString()}
              className="min-h-[6rem] p-1.5"
              style={{ backgroundColor: inMonth ? "var(--jms-surface)" : "var(--jms-bg)" }}
            >
              <p
                className="mb-1 font-bold"
                style={{ color: today ? "var(--jms-accent)" : inMonth ? "var(--jms-text)" : "var(--jms-text-muted)", fontSize: "11px" }}
              >
                {day.getDate()}
              </p>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 4).map((task) => (
                  <button
                    key={task.id}
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    className="block w-full truncate rounded border px-1 py-0.5 text-left font-semibold hover:opacity-80"
                    style={{
                      borderColor: isOverdue(task) ? "var(--jms-danger)" : PRIORITY_COLOR_VAR[task.priority],
                      color: PRIORITY_COLOR_VAR[task.priority],
                      fontSize: "11px",
                    }}
                  >
                    {task.title}
                  </button>
                ))}
                {dayTasks.length > 4 ? (
                  <p style={{ color: "var(--jms-text-muted)", fontSize: "10px" }}>+{dayTasks.length - 4} more</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
