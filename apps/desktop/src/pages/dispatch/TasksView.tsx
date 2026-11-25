import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Profile, Task } from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { fetchAllRows } from "../../lib/fetch-all-rows";
import { getErrorMessage } from "../../lib/errors";
import { fmtDay } from "../../components/AssetEditor";
import { addDaysKey, dayKeyOf } from "./drag";

// Tasks as a plain list, grouped by when they're due, with a tick box to
// mark one done. The full task tools (projects, board, matrix) stay on
// the Tasks page; this is the office's day-to-day checklist.

type TaskRow = Task & { job_cards: { id: string; number: string | null; title: string } | null; clients: { id: string; name: string } | null };
const KEY = ["dispatch", "tasks"];
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;

type Group = "overdue" | "today" | "week" | "later" | "none" | "done";
const GROUP_LABELS: Record<Group, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "Next 7 days",
  later: "Later",
  none: "No due date",
  done: "Done in the last 7 days",
};

export function groupOf(task: Pick<Task, "status" | "due_date">, today: string): Group {
  if (task.status === "done") return "done";
  if (!task.due_date) return "none";
  if (task.due_date < today) return "overdue";
  if (task.due_date === today) return "today";
  if (task.due_date <= addDaysKey(today, 7)) return "week";
  return "later";
}

export function TasksView({ people }: { people: Profile[] }) {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [who, setWho] = useState<string>("all");
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const today = dayKeyOf(new Date());

  const { data: tasks, error } = useQuery({
    queryKey: KEY,
    queryFn: () => {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      return fetchAllRows<TaskRow>("tasks", "*, job_cards(id, number, title), clients(id, name)", (q) =>
        q.is("parent_task_id", null).or(`status.neq.done,updated_at.gte.${weekAgo}`).order("due_date", { ascending: true, nullsFirst: false })
      );
    },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: KEY });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };
  const toggle = useMutation({
    mutationFn: async (t: TaskRow) => {
      const { error: e } = await supabase.from("tasks").update({ status: t.status === "done" ? "todo" : "done" }).eq("id", t.id);
      if (e) throw e;
    },
    onMutate: (t) =>
      queryClient.setQueryData<TaskRow[]>(KEY, (old) => (old ?? []).map((x) => (x.id === t.id ? { ...x, status: t.status === "done" ? "todo" : "done", updated_at: new Date().toISOString() } : x))),
    onSettled: refresh,
  });
  const add = useMutation({
    mutationFn: async () => {
      const { error: e } = await supabase.from("tasks").insert({
        tenant_id: profile!.tenant_id,
        title: title.trim(),
        due_date: due || null,
        assigned_to: assignee || null,
        created_by: profile!.id,
      });
      if (e) throw e;
    },
    onSuccess: () => {
      setTitle("");
      setDue("");
      refresh();
    },
  });

  const nameOf = useMemo(() => new Map(people.map((p) => [p.id, p.full_name || p.email || "Someone"])), [people]);
  const groups = useMemo(() => {
    const out = new Map<Group, TaskRow[]>();
    for (const t of tasks ?? []) {
      if (who !== "all" && (who === "none" ? t.assigned_to : t.assigned_to !== who)) continue;
      const g = groupOf(t, today);
      if (g === "done" && !showDone) continue;
      out.set(g, [...(out.get(g) ?? []), t]);
    }
    return out;
  }, [tasks, who, showDone, today]);
  const order: Group[] = ["overdue", "today", "week", "later", "none", "done"];
  const openCount = order.filter((g) => g !== "done").reduce((n, g) => n + (groups.get(g)?.length ?? 0), 0);

  return (
    <div className="h-full overflow-y-auto p-4" data-testid="tasks-view">
      <div className="mx-auto max-w-4xl">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            <strong>{openCount}</strong> open task{openCount === 1 ? "" : "s"}
            {groups.get("overdue")?.length ? <span style={{ color: "var(--jms-danger)" }}>, {groups.get("overdue")!.length} overdue</span> : null}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <select value={who} onChange={(e) => setWho(e.target.value)} className="rounded border px-2 py-1" style={inputStyle} aria-label="Whose tasks">
              <option value="all">Everyone</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name || p.email}
                </option>
              ))}
              <option value="none">Not assigned</option>
            </select>
            <label className="flex items-center gap-1.5" style={muted}>
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
            </label>
            <Link to="/tasks" className="hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
              All task tools →
            </Link>
          </div>
        </div>

        {isAdmin ? (
          <form
            className="mb-4 flex flex-wrap gap-2 rounded-md p-2"
            style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) add.mutate();
            }}
          >
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" className="min-w-[200px] flex-1 rounded border px-2 py-1.5" style={inputStyle} aria-label="New task" />
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="rounded border px-2 py-1.5" style={inputStyle} aria-label="Due" />
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="rounded border px-2 py-1.5" style={inputStyle} aria-label="Assign to">
              <option value="">Not assigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name || p.email}
                </option>
              ))}
            </select>
            <button type="submit" disabled={!title.trim() || add.isPending} className="rounded px-3 py-1.5 font-semibold" style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)", fontSize: "var(--jms-font-body)", opacity: title.trim() ? 1 : 0.5 }}>
              Add
            </button>
          </form>
        ) : null}

        {error || toggle.error || add.error ? (
          <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {getErrorMessage(error ?? toggle.error ?? add.error, "Couldn't load tasks")}
          </p>
        ) : null}
        {tasks && openCount === 0 && !showDone ? <p style={muted}>Nothing to do. Nice.</p> : null}

        {order.map((g) => {
          const list = groups.get(g);
          if (!list?.length) return null;
          return (
            <section key={g} className="mb-5" data-testid="task-group" data-group={g}>
              <h3 className="mb-1 font-bold uppercase tracking-wide" style={{ color: g === "overdue" ? "var(--jms-danger)" : "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.08em" }}>
                {GROUP_LABELS[g]} <span style={{ color: "var(--jms-text-muted)" }}>{list.length}</span>
              </h3>
              <ul className="overflow-hidden rounded-md" style={{ border: "1px solid var(--jms-border)" }}>
                {list.map((t, i) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-3 px-3 py-2"
                    style={{ backgroundColor: "var(--jms-surface)", borderTop: i ? "1px solid var(--jms-border)" : undefined }}
                    data-testid="task-row"
                  >
                    <input
                      type="checkbox"
                      checked={t.status === "done"}
                      onChange={() => toggle.mutate(t)}
                      className="h-4 w-4 shrink-0 cursor-pointer"
                      style={{ accentColor: "var(--jms-accent)" }}
                      aria-label={`Mark "${t.title}" ${t.status === "done" ? "not done" : "done"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)", textDecoration: t.status === "done" ? "line-through" : undefined, opacity: t.status === "done" ? 0.6 : 1 }}>
                        {t.title}
                        {t.status === "in_progress" ? <span style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}> · in progress</span> : null}
                      </p>
                      <p className="truncate" style={muted}>
                        {[t.number, t.job_cards ? null : t.clients?.name].filter(Boolean).join(" · ")}
                        {t.job_cards ? (
                          <Link to={`/jobs/${t.job_cards.id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                            {t.number ? " · " : ""}
                            {t.job_cards.number ?? "Job"} {t.job_cards.title}
                          </Link>
                        ) : null}
                      </p>
                    </div>
                    <span className="hidden shrink-0 sm:inline" style={muted}>
                      {t.assigned_to ? nameOf.get(t.assigned_to) ?? "Someone" : "Not assigned"}
                    </span>
                    <span className="w-24 shrink-0 text-right" style={{ ...muted, color: g === "overdue" ? "var(--jms-danger)" : muted.color }}>
                      {t.due_date ? fmtDay(t.due_date) : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
