import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createTaskNoteSchema, createTaskSchema, type Task, type TaskFile, type TaskNote, type TaskStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { uploadTaskPhoto } from "../lib/uploads";
import { Modal } from "../components/Modal";
import { FormField, TextAreaField } from "../components/FormField";

// Direct port of apps/mobile/app/(tabs)/tasks/[id].tsx - same status
// chips, edit modal, linked-job link, photos, notes, delete. Photos use
// the same signed-URL pattern as JobDetail.tsx (job-files bucket is
// private, see supabase/migrations/20260720000300_storage.sql) rather than
// mobile's offline attachment queue, since desktop has no offline mode.

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

async function fetchTask(id: string): Promise<Task> {
  const { data, error } = await supabase.from("tasks").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Task;
}
async function fetchNotes(taskId: string): Promise<TaskNote[]> {
  const { data, error } = await supabase
    .from("task_notes")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as TaskNote[];
}
async function fetchFiles(taskId: string): Promise<TaskFile[]> {
  const { data, error } = await supabase
    .from("task_files")
    .select("*")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as TaskFile[];
}
async function fetchFileUrls(files: TaskFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (f) => {
      const { data } = await supabase.storage.from("job-files").createSignedUrl(f.storage_path, 3600);
      return [f.id, data?.signedUrl ?? ""] as const;
    })
  );
  return Object.fromEntries(entries);
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: task } = useQuery({ queryKey: ["task", id], queryFn: () => fetchTask(id!), enabled: !!id });
  const { data: notes } = useQuery({ queryKey: ["task-notes", id], queryFn: () => fetchNotes(id!), enabled: !!id });
  const { data: files } = useQuery({ queryKey: ["task-files", id], queryFn: () => fetchFiles(id!), enabled: !!id });
  const { data: fileUrls } = useQuery({
    queryKey: ["task-file-urls", id, files?.map((f) => f.id).join(",")],
    queryFn: () => fetchFileUrls(files!),
    enabled: !!files && files.length > 0,
  });

  const updateTask = useMutation({
    mutationFn: async (patch: Partial<Task>) => {
      const { error } = await supabase.from("tasks").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", id] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const [photoError, setPhotoError] = useState<string | null>(null);
  const uploadPhotos = useMutation({
    mutationFn: async (fileList: FileList) => {
      if (!profile) throw new Error("Not signed in");
      for (const file of Array.from(fileList)) {
        await uploadTaskPhoto({ tenantId: profile.tenant_id, taskId: id!, uploadedBy: profile.id, file });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-files", id] });
      setPhotoError(null);
    },
    onError: (e) => setPhotoError(getErrorMessage(e, "Failed to upload photo")),
  });

  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  const addNote = useMutation({
    mutationFn: async () => {
      const result = createTaskNoteSchema.safeParse({ task_id: id, body: noteBody });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("task_notes").insert({
        tenant_id: profile.tenant_id,
        task_id: id,
        author_id: profile.id,
        body: result.data.body,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-notes", id] });
      setNoteBody("");
      setNoteError(null);
    },
    onError: (e) => setNoteError(getErrorMessage(e, "Failed to add note")),
  });

  const deleteTask = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("tasks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      navigate("/tasks");
    },
  });

  const handleDelete = () => {
    if (window.confirm("Delete this task? This can't be undone.")) deleteTask.mutate();
  };

  // --- Edit task title/description/due date ---
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (task) {
      setEditTitle(task.title);
      setEditDescription(task.description ?? "");
      setEditDueDate(task.due_date ?? "");
    }
  }, [task]);

  const openEditModal = () => {
    if (!task) return;
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditDueDate(task.due_date ?? "");
    setEditError(null);
    setEditModalOpen(true);
  };

  const saveEdit = useMutation({
    mutationFn: async () => {
      const result = createTaskSchema.safeParse({
        title: editTitle,
        description: editDescription,
        job_card_id: task?.job_card_id ?? undefined,
        assigned_to: task?.assigned_to ?? undefined,
        due_date: editDueDate || undefined,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid task");

      const { error } = await supabase
        .from("tasks")
        .update({
          title: result.data.title,
          description: result.data.description || null,
          due_date: result.data.due_date || null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task", id] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setEditModalOpen(false);
    },
    onError: (e) => setEditError(getErrorMessage(e, "Failed to save")),
  });

  if (!task) {
    return <div className="p-8 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="p-8">
      <Link to="/tasks" className="mb-4 inline-block text-sm text-blue-700 hover:underline">
        &larr; Back to Tasks
      </Link>

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-blue-700">{task.number ?? "Pending"}</span>
            <h1 className="text-xl font-bold text-gray-900">{task.title}</h1>
          </div>
          <button onClick={openEditModal} className="text-sm font-semibold text-blue-700 hover:underline">
            Edit
          </button>
        </div>
        {task.description ? <p className="mb-2 text-sm text-gray-600">{task.description}</p> : null}
        {task.due_date ? <p className="text-sm text-gray-500">Due {task.due_date}</p> : null}

        {task.job_card_id ? (
          <Link to={`/jobs/${task.job_card_id}`} className="mt-3 inline-block text-sm font-semibold text-blue-700 hover:underline">
            View linked job
          </Link>
        ) : null}
      </div>

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Status</h2>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => (
            <button
              key={status}
              onClick={() => updateTask.mutate({ status })}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
                task.status === status ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"
              }`}
            >
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">Photos</h2>
          <label className="cursor-pointer rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800">
            {uploadPhotos.isPending ? "Uploading..." : "+ Upload photos"}
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              disabled={uploadPhotos.isPending}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) uploadPhotos.mutate(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {photoError ? <p className="mb-3 text-sm text-red-600">{photoError}</p> : null}
        {!files || files.length === 0 ? (
          <p className="text-sm text-gray-500">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {files.map((f) => (
              <a
                key={f.id}
                href={fileUrls?.[f.id] || undefined}
                target="_blank"
                rel="noreferrer"
                className="block aspect-square overflow-hidden rounded-md border border-gray-300 bg-gray-100"
              >
                {fileUrls?.[f.id] ? (
                  <img src={fileUrls[f.id]} alt={f.file_name} className="h-full w-full object-cover" />
                ) : null}
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Notes</h2>
        <div className="mb-4">
          <TextAreaField label="Add a note" rows={2} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
          {noteError ? <p className="mb-2 text-sm text-red-600">{noteError}</p> : null}
          <button
            onClick={() => addNote.mutate()}
            disabled={addNote.isPending || !noteBody.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {addNote.isPending ? "Adding..." : "Add note"}
          </button>
        </div>
        <div className="space-y-3">
          {(notes ?? []).map((note) => (
            <div key={note.id} className="border-t border-gray-200 pt-3 text-sm">
              <p className="text-gray-800">{note.body}</p>
              <p className="mt-1 text-xs text-gray-400">{new Date(note.created_at).toLocaleString()}</p>
            </div>
          ))}
          {notes && notes.length === 0 ? <p className="text-sm text-gray-500">No notes yet.</p> : null}
        </div>
      </div>

      <button onClick={handleDelete} className="rounded-md bg-red-50 px-4 py-2.5 text-sm font-bold text-red-600 hover:bg-red-100">
        Delete task
      </button>

      <Modal open={editModalOpen} onClose={() => setEditModalOpen(false)} title="Edit task">
        <FormField label="Title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
        <TextAreaField label="Description (optional)" rows={3} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
        <FormField label="Due date (optional)" type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
        {editError ? <p className="mb-4 text-sm text-red-600">{editError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setEditModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => saveEdit.mutate()}
            disabled={saveEdit.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {saveEdit.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
