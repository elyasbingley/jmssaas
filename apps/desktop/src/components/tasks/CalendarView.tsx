import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Task } from "@jmssaas/shared";
import { addMonths, isSameDay, monthGridDays, startOfMonth } from "../../lib/datetime";
import { isOverdue, PRIORITY_COLORS } from "./taskHelpers";

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
        <button onClick={() => setMonthAnchor((d) => addMonths(d, -1))} className="text-xl font-bold text-blue-700">
          &lsaquo;
        </button>
        <button onClick={() => setMonthAnchor(startOfMonth(new Date()))} className="text-sm font-bold text-gray-900 hover:underline">
          {monthAnchor.toLocaleDateString("en-AU", { month: "long", year: "numeric" })}
        </button>
        <button onClick={() => setMonthAnchor((d) => addMonths(d, 1))} className="text-xl font-bold text-blue-700">
          &rsaquo;
        </button>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-gray-300 bg-gray-200 text-xs">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="bg-gray-50 px-2 py-1.5 text-center font-bold text-gray-500">
            {d}
          </div>
        ))}
        {days.map((day) => {
          const inMonth = day.getMonth() === monthAnchor.getMonth();
          const today = isSameDay(day, new Date());
          const dayTasks = tasksByDate.get(dateKey(day)) ?? [];
          return (
            <div key={day.toISOString()} className={`min-h-[6rem] bg-white p-1.5 ${inMonth ? "" : "bg-gray-50"}`}>
              <p className={`mb-1 text-[11px] font-bold ${today ? "text-blue-700" : inMonth ? "text-gray-700" : "text-gray-300"}`}>
                {day.getDate()}
              </p>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 4).map((task) => (
                  <button
                    key={task.id}
                    onClick={() => navigate(`/tasks/${task.id}`)}
                    className={`block w-full truncate rounded px-1 py-0.5 text-left text-[11px] font-semibold hover:opacity-80 ${PRIORITY_COLORS[task.priority]} ${
                      isOverdue(task) ? "ring-1 ring-red-400" : ""
                    }`}
                  >
                    {task.title}
                  </button>
                ))}
                {dayTasks.length > 4 ? <p className="text-[10px] text-gray-400">+{dayTasks.length - 4} more</p> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
