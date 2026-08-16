import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { createTaskSchema, type Task, type TaskStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";

// Direct port of apps/mobile/app/(tabs)/tasks/index.tsx - same status
// filter chips, same list shape. Desktop is admin-only (RequireAdmin wraps
// every route), so this always shows the whole tenant's tasks - there's no
// "assigned to me" split like mobile's technician view.

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

type StatusFilter = TaskStatus | "all";

async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Task[];
}

export default function TasksPage() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: tasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: fetchTasks });

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const filteredTasks = useMemo(
    () => (statusFilter === "all" ? (tasks ?? []) : (tasks ?? []).filter((t) => t.status === statusFilter)),
    [tasks, statusFilter]
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setDueDate("");
    setFormError(null);
  };

  const createTask = useMutation({
    mutationFn: async () => {
      const result = createTaskSchema.safeParse({ title, description, due_date: dueDate || undefined });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid task");
      if (!profile) throw new Error("Not signed in");

      const { data, error } = await supabase
        .from("tasks")
        .insert({
          tenant_id: profile.tenant_id,
          title: result.data.title,
          description: result.data.description || null,
          status: "todo",
          due_date: result.data.due_date || null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Task;
    },
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      resetForm();
      setModalOpen(false);
      navigate(`/tasks/${task.id}`);
    },
    onError: (e) => setFormError(getErrorMessage(e, "Failed to create task")),
  });

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Tasks</h1>
          <p className="text-sm text-gray-500">{tasks?.length ?? 0} tasks</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New task
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {(["all", ...STATUSES] as StatusFilter[]).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
              statusFilter === status ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"
            }`}
          >
            {status === "all" ? "All" : STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-300 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : filteredTasks.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No tasks here.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-300 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Title</th>
                <th className="px-4 py-2 font-semibold">Due</th>
                <th className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map((task) => (
                <tr key={task.id} className="border-b border-gray-200 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-blue-700">
                    <Link to={`/tasks/${task.id}`} className="hover:underline">
                      {task.number ?? "Pending"}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/tasks/${task.id}`} className="font-medium hover:underline">
                      {task.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{task.due_date ?? ""}</td>
                  <td className="px-4 py-3 font-semibold text-gray-700">{STATUS_LABELS[task.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title="New task"
      >
        <FormField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextAreaField label="Description (optional)" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        <FormField label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        {formError ? <p className="mb-4 text-sm text-red-600">{formError}</p> : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setModalOpen(false);
              resetForm();
            }}
            className="px-4 py-2 text-sm font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={() => createTask.mutate()}
            disabled={createTask.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createTask.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
