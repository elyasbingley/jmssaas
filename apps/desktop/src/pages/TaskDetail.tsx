import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createTaskDependencySchema,
  createTaskNoteSchema,
  createTaskSchema,
  setTaskCustomFieldValueSchema,
  type Client,
  type JobCard,
  type Profile,
  type Property,
  type Task,
  type TaskActivityLog,
  type TaskCustomField,
  type TaskCustomFieldValue,
  type TaskDependency,
  type TaskFile,
  type TaskNote,
  type TaskPriority,
  type TaskProject,
  type TaskSection,
  type TaskStatus,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { uploadTaskPhoto } from "../lib/uploads";
import { FormField, SelectField, TextAreaField } from "../components/FormField";
import { PRIORITY_LABELS, PRIORITY_ORDER, dependencyGuardrailMessage, unresolvedBlockers } from "../components/tasks/taskHelpers";

// Slide-over drawer (see Tasks.tsx's fixed right-side panel + nested
// /tasks/:id route) - Asana-style task detail: properties grid, JMS
// entity links, per-project custom fields, dependency management,
// subtask checklist, and a merged activity/comment feed. Photos keep the
// same signed-URL pattern as before (desktop has no offline mode, so no
// PowerSync attachment queue is needed).

const STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };

async function fetchTask(id: string): Promise<Task> {
  const { data, error } = await supabase.from("tasks").select("*").eq("id", id).single();
  if (error) throw error;
  return data as Task;
}
async function fetchAllTasksLite(): Promise<Task[]> {
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) throw error;
  return data as Task[];
}
async function fetchProjects(): Promise<TaskProject[]> {
  const { data, error } = await supabase.from("task_projects").select("*");
  if (error) throw error;
  return data as TaskProject[];
}
async function fetchSections(): Promise<TaskSection[]> {
  const { data, error } = await supabase.from("task_sections").select("*");
  if (error) throw error;
  return data as TaskSection[];
}
async function fetchProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name");
  if (error) throw error;
  return data as Profile[];
}
async function fetchJobCards(): Promise<JobCard[]> {
  const { data, error } = await supabase.from("job_cards").select("*");
  if (error) throw error;
  return data as JobCard[];
}
async function fetchClients(): Promise<Client[]> {
  const { data, error } = await supabase.from("clients").select("*").order("name");
  if (error) throw error;
  return data as Client[];
}
async function fetchProperties(): Promise<Property[]> {
  const { data, error } = await supabase.from("properties").select("*").order("address_line1");
  if (error) throw error;
  return data as Property[];
}
async function fetchDependencies(taskId: string): Promise<TaskDependency[]> {
  const { data, error } = await supabase
    .from("task_dependencies")
    .select("*")
    .or(`blocking_task_id.eq.${taskId},dependent_task_id.eq.${taskId}`);
  if (error) throw error;
  return data as TaskDependency[];
}
async function fetchCustomFields(projectId: string): Promise<TaskCustomField[]> {
  const { data, error } = await supabase.from("task_custom_fields").select("*").eq("project_id", projectId).order("position_order");
  if (error) throw error;
  return data as TaskCustomField[];
}
async function fetchCustomFieldValues(taskId: string): Promise<TaskCustomFieldValue[]> {
  const { data, error } = await supabase.from("task_custom_field_values").select("*").eq("task_id", taskId);
  if (error) throw error;
  return data as TaskCustomFieldValue[];
}
async function fetchActivityLogs(taskId: string): Promise<TaskActivityLog[]> {
  const { data, error } = await supabase.from("task_activity_logs").select("*").eq("task_id", taskId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as TaskActivityLog[];
}
async function fetchNotes(taskId: string): Promise<TaskNote[]> {
  const { data, error } = await supabase.from("task_notes").select("*").eq("task_id", taskId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as TaskNote[];
}
async function fetchFiles(taskId: string): Promise<TaskFile[]> {
  const { data, error } = await supabase.from("task_files").select("*").eq("task_id", taskId).order("created_at", { ascending: false });
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

function activityLine(log: TaskActivityLog, profilesById: Map<string, Profile>): string {
  const actor = (log.actor_id && profilesById.get(log.actor_id)?.full_name) || "Someone";
  if (log.field_name === "milestone_completed") return `${actor} completed milestone "${log.new_value}"`;
  const fieldLabel = log.field_name.replace(/_/g, " ");
  return `${actor} changed ${fieldLabel} from "${log.old_value ?? "none"}" to "${log.new_value ?? "none"}"`;
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const { data: task } = useQuery({ queryKey: ["task", id], queryFn: () => fetchTask(id!), enabled: !!id });
  const { data: allTasks } = useQuery({ queryKey: ["tasks"], queryFn: fetchAllTasksLite });
  const { data: projects } = useQuery({ queryKey: ["task-projects"], queryFn: fetchProjects });
  const { data: sections } = useQuery({ queryKey: ["task-sections-all"], queryFn: fetchSections });
  const { data: profiles } = useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles });
  const { data: jobCards } = useQuery({ queryKey: ["job-cards-min"], queryFn: fetchJobCards });
  const { data: clients } = useQuery({ queryKey: ["clients-min"], queryFn: fetchClients });
  const { data: properties } = useQuery({ queryKey: ["properties-min"], queryFn: fetchProperties });
  const { data: dependencies } = useQuery({ queryKey: ["task-dependencies", id], queryFn: () => fetchDependencies(id!), enabled: !!id });
  const { data: customFields } = useQuery({
    queryKey: ["task-custom-fields", task?.project_id],
    queryFn: () => fetchCustomFields(task!.project_id!),
    enabled: !!task?.project_id,
  });
  const { data: customFieldValues } = useQuery({
    queryKey: ["task-custom-field-values", id],
    queryFn: () => fetchCustomFieldValues(id!),
    enabled: !!id,
  });
  const { data: activityLogs } = useQuery({ queryKey: ["task-activity", id], queryFn: () => fetchActivityLogs(id!), enabled: !!id });
  const { data: notes } = useQuery({ queryKey: ["task-notes", id], queryFn: () => fetchNotes(id!), enabled: !!id });
  const { data: files } = useQuery({ queryKey: ["task-files", id], queryFn: () => fetchFiles(id!), enabled: !!id });
  const { data: fileUrls } = useQuery({
    queryKey: ["task-file-urls", id, files?.map((f) => f.id).join(",")],
    queryFn: () => fetchFileUrls(files!),
    enabled: !!files && files.length > 0,
  });

  const profilesById = useMemo(() => new Map((profiles ?? []).map((p) => [p.id, p])), [profiles]);
  const tasksById = useMemo(() => new Map((allTasks ?? []).map((t) => [t.id, t])), [allTasks]);
  const project = projects?.find((p) => p.id === task?.project_id) ?? null;
  const section = sections?.find((s) => s.id === task?.section_id) ?? null;
  const parentTask = task?.parent_task_id ? tasksById.get(task.parent_task_id) : null;
  const subtasks = useMemo(() => (allTasks ?? []).filter((t) => t.parent_task_id === id).sort((a, b) => a.position_order - b.position_order), [allTasks, id]);

  const invalidateTask = () => {
    queryClient.invalidateQueries({ queryKey: ["task", id] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["task-activity", id] });
  };

  const updateTask = useMutation({
    mutationFn: async (patch: Partial<Task>) => {
      const { error } = await supabase.from("tasks").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidateTask,
  });

  // Dependency guardrail - marking a task complete while something still
  // blocking it is unresolved warns rather than silently allowing it,
  // matching the spec's own wording; an admin can still override.
  const handleComplete = () => {
    if (!task) return;
    if (task.status === "done") {
      updateTask.mutate({ status: "todo" });
      return;
    }
    const blockers = unresolvedBlockers(task.id, dependencies ?? [], tasksById);
    if (blockers.length > 0 && !window.confirm(dependencyGuardrailMessage(blockers))) return;
    updateTask.mutate({ status: "done" });
  };

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

  // --- Edit title/description (inline) ---
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  useEffect(() => {
    if (task) {
      setTitleDraft(task.title);
      setDescriptionDraft(task.description ?? "");
    }
  }, [task?.id]);

  const commitTitle = () => {
    setEditingTitle(false);
    if (task && titleDraft.trim() && titleDraft !== task.title) updateTask.mutate({ title: titleDraft.trim() });
  };
  const commitDescription = () => {
    if (task && descriptionDraft !== (task.description ?? "")) updateTask.mutate({ description: descriptionDraft || null });
  };

  // --- Photos ---
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

  // --- Comments ---
  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const addNote = useMutation({
    mutationFn: async () => {
      const result = createTaskNoteSchema.safeParse({ task_id: id, body: noteBody });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid note");
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase.from("task_notes").insert({ tenant_id: profile.tenant_id, task_id: id, author_id: profile.id, body: result.data.body });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-notes", id] });
      setNoteBody("");
      setNoteError(null);
    },
    onError: (e) => setNoteError(getErrorMessage(e, "Failed to add note")),
  });

  // --- Subtasks ---
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const addSubtask = useMutation({
    mutationFn: async () => {
      const result = createTaskSchema.safeParse({ title: subtaskTitle, parent_task_id: id, project_id: task?.project_id ?? undefined, section_id: task?.section_id ?? undefined });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid subtask");
      if (!profile || !task) throw new Error("Not signed in");
      const { error } = await supabase.from("tasks").insert({
        tenant_id: profile.tenant_id,
        title: result.data.title,
        status: "todo",
        parent_task_id: id,
        project_id: task.project_id,
        section_id: task.section_id,
        created_by: profile.id,
        position_order: subtasks.length,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      setSubtaskTitle("");
    },
  });
  const toggleSubtask = useMutation({
    mutationFn: async ({ subtaskId, done }: { subtaskId: string; done: boolean }) => {
      const { error } = await supabase.from("tasks").update({ status: done ? "done" : "todo" }).eq("id", subtaskId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
  const moveSubtask = useMutation({
    mutationFn: async ({ subtaskId, positionOrder }: { subtaskId: string; positionOrder: number }) => {
      const { error } = await supabase.from("tasks").update({ position_order: positionOrder }).eq("id", subtaskId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });
  const reorderSubtask = (index: number, direction: -1 | 1) => {
    const target = subtasks[index + direction];
    const current = subtasks[index];
    if (!target || !current) return;
    moveSubtask.mutate({ subtaskId: current.id, positionOrder: target.position_order });
    moveSubtask.mutate({ subtaskId: target.id, positionOrder: current.position_order });
  };

  // --- Dependencies ---
  const [dependencySearch, setDependencySearch] = useState("");
  const [dependencyError, setDependencyError] = useState<string | null>(null);
  const blockedBy = (dependencies ?? []).filter((d) => d.dependent_task_id === id);
  const blocking = (dependencies ?? []).filter((d) => d.blocking_task_id === id);

  const addDependency = useMutation({
    mutationFn: async ({ otherTaskId, direction }: { otherTaskId: string; direction: "blocked_by" | "blocking" }) => {
      const payload =
        direction === "blocked_by"
          ? { blocking_task_id: otherTaskId, dependent_task_id: id }
          : { blocking_task_id: id, dependent_task_id: otherTaskId };
      const result = createTaskDependencySchema.safeParse(payload);
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid dependency");
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase.from("task_dependencies").insert({ tenant_id: profile.tenant_id, ...result.data });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-dependencies", id] });
      setDependencySearch("");
      setDependencyError(null);
    },
    onError: (e) => setDependencyError(getErrorMessage(e, "Failed to add dependency")),
  });
  const removeDependency = useMutation({
    mutationFn: async (dependencyId: string) => {
      const { error } = await supabase.from("task_dependencies").delete().eq("id", dependencyId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-dependencies", id] }),
  });

  const dependencySearchResults = useMemo(() => {
    if (!dependencySearch.trim()) return [];
    const q = dependencySearch.trim().toLowerCase();
    return (allTasks ?? [])
      .filter((t) => t.id !== id && t.title.toLowerCase().includes(q))
      .filter((t) => !blockedBy.some((d) => d.blocking_task_id === t.id) && !blocking.some((d) => d.dependent_task_id === t.id))
      .slice(0, 6);
  }, [dependencySearch, allTasks, id, blockedBy, blocking]);

  // --- Custom field values ---
  const setCustomFieldValue = useMutation({
    mutationFn: async (params: { customFieldId: string; patch: { value_text?: string | null; value_number?: number | null; value_date?: string | null } }) => {
      const result = setTaskCustomFieldValueSchema.safeParse({ task_id: id, custom_field_id: params.customFieldId, ...params.patch });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid value");
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase
        .from("task_custom_field_values")
        .upsert({ tenant_id: profile.tenant_id, task_id: id, custom_field_id: params.customFieldId, ...params.patch }, { onConflict: "task_id,custom_field_id" });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-custom-field-values", id] }),
  });
  const customFieldValuesByFieldId = useMemo(() => new Map((customFieldValues ?? []).map((v) => [v.custom_field_id, v])), [customFieldValues]);

  // --- Merged activity + comment feed ---
  const feed = useMemo(() => {
    const activityItems = (activityLogs ?? []).map((log) => ({ kind: "activity" as const, id: log.id, at: log.created_at, log }));
    const noteItems = (notes ?? []).map((note) => ({ kind: "note" as const, id: note.id, at: note.created_at, note }));
    return [...activityItems, ...noteItems].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [activityLogs, notes]);

  if (!task) {
    return <div className="p-6 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 p-5">
        <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-gray-400">
          <Link to="/tasks" className="hover:underline">
            Tasks
          </Link>
          {project ? <span> / {project.name}</span> : null}
          {section ? <span> / {section.name}</span> : null}
          {parentTask ? (
            <span>
              {" "}
              /{" "}
              <Link to={`/tasks/${parentTask.id}`} className="text-blue-700 hover:underline">
                {parentTask.title}
              </Link>
            </span>
          ) : null}
        </div>

        <div className="mb-3 flex items-start gap-2">
          <button
            onClick={handleComplete}
            title={task.status === "done" ? "Mark incomplete" : "Mark complete"}
            className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${
              task.status === "done" ? "border-green-600 bg-green-600 text-white" : "border-gray-300 text-transparent hover:border-green-500"
            }`}
          >
            &#10003;
          </button>
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => e.key === "Enter" && commitTitle()}
              className="flex-1 rounded border border-blue-400 px-2 py-1 text-lg font-bold"
            />
          ) : (
            <h1
              onClick={() => setEditingTitle(true)}
              className={`flex-1 cursor-text text-lg font-bold ${task.status === "done" ? "text-gray-400 line-through" : "text-gray-900"}`}
            >
              {task.title}
            </h1>
          )}
          <button onClick={handleDelete} title="Delete task" className="text-gray-400 hover:text-red-600">
            &#128465;
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={task.priority}
            onChange={(e) => updateTask.mutate({ priority: e.target.value as TaskPriority })}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-semibold"
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
            <input type="checkbox" checked={task.is_milestone} onChange={(e) => updateTask.mutate({ is_milestone: e.target.checked })} />
            Milestone
          </label>
        </div>

        <TextAreaField
          label="Description"
          rows={2}
          value={descriptionDraft}
          onChange={(e) => setDescriptionDraft(e.target.value)}
          onBlur={commitDescription}
          className="mt-3"
        />
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Properties</h2>
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="Assignee"
              value={task.assigned_to ?? ""}
              onChange={(v) => updateTask.mutate({ assigned_to: v || null })}
              placeholder="Unassigned"
              options={(profiles ?? []).map((p) => ({ value: p.id, label: p.full_name }))}
            />
            <SelectField
              label="Status"
              value={task.status}
              onChange={(v) => v && updateTask.mutate({ status: v as TaskStatus })}
              placeholder="To do"
              options={(["todo", "in_progress", "done"] as TaskStatus[]).map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
            />
            <FormField label="Start date" type="date" value={task.start_date ?? ""} onChange={(e) => updateTask.mutate({ start_date: e.target.value || null })} />
            <FormField label="Due date" type="date" value={task.due_date ?? ""} onChange={(e) => updateTask.mutate({ due_date: e.target.value || null })} />
            <FormField
              label="Estimated hours"
              type="number"
              step="0.25"
              value={task.estimated_hours ?? ""}
              onChange={(e) => updateTask.mutate({ estimated_hours: e.target.value ? Number(e.target.value) : null })}
            />
            <FormField
              label="Actual hours"
              type="number"
              step="0.25"
              value={task.actual_hours ?? ""}
              onChange={(e) => updateTask.mutate({ actual_hours: e.target.value ? Number(e.target.value) : null })}
            />
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">JMS entity links</h2>
          <div className="grid grid-cols-1 gap-3">
            <SelectField
              label="Job"
              value={task.job_card_id ?? ""}
              onChange={(v) => updateTask.mutate({ job_card_id: v || null })}
              placeholder="No linked job"
              options={(jobCards ?? []).map((j) => ({ value: j.id, label: `${j.number ?? "Pending"} - ${j.title}` }))}
            />
            {task.job_card_id ? (
              <Link to={`/jobs/${task.job_card_id}`} className="-mt-2 text-xs font-semibold text-blue-700 hover:underline">
                View linked job
              </Link>
            ) : null}
            <SelectField
              label="Client"
              value={task.client_id ?? ""}
              onChange={(v) => updateTask.mutate({ client_id: v || null })}
              placeholder="No linked client"
              options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
            />
            <SelectField
              label="Property"
              value={task.property_id ?? ""}
              onChange={(v) => updateTask.mutate({ property_id: v || null })}
              placeholder="No linked property"
              options={(properties ?? []).map((p) => ({ value: p.id, label: p.address_line1 }))}
            />
          </div>
        </section>

        {task.project_id && (customFields ?? []).length > 0 ? (
          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Custom fields</h2>
            <div className="space-y-3">
              {customFields!.map((field) => {
                const value = customFieldValuesByFieldId.get(field.id);
                if (field.field_type === "dropdown") {
                  return (
                    <SelectField
                      key={field.id}
                      label={field.name}
                      value={value?.value_text ?? ""}
                      onChange={(v) => setCustomFieldValue.mutate({ customFieldId: field.id, patch: { value_text: v || null } })}
                      options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
                    />
                  );
                }
                if (field.field_type === "number") {
                  return (
                    <FormField
                      key={field.id}
                      label={field.name}
                      type="number"
                      defaultValue={value?.value_number ?? ""}
                      onBlur={(e) =>
                        setCustomFieldValue.mutate({ customFieldId: field.id, patch: { value_number: e.target.value ? Number(e.target.value) : null } })
                      }
                    />
                  );
                }
                if (field.field_type === "date") {
                  return (
                    <FormField
                      key={field.id}
                      label={field.name}
                      type="date"
                      defaultValue={value?.value_date ?? ""}
                      onBlur={(e) => setCustomFieldValue.mutate({ customFieldId: field.id, patch: { value_date: e.target.value || null } })}
                    />
                  );
                }
                return (
                  <FormField
                    key={field.id}
                    label={field.name}
                    defaultValue={value?.value_text ?? ""}
                    onBlur={(e) => setCustomFieldValue.mutate({ customFieldId: field.id, patch: { value_text: e.target.value || null } })}
                  />
                );
              })}
            </div>
          </section>
        ) : null}

        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Dependencies</h2>
          <div className="mb-3">
            <p className="mb-1 text-xs font-semibold text-gray-600">Blocked by</p>
            {blockedBy.length === 0 ? (
              <p className="text-xs text-gray-400">Nothing blocking this task.</p>
            ) : (
              blockedBy.map((dep) => {
                const other = tasksById.get(dep.blocking_task_id);
                return (
                  <div key={dep.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1 text-sm">
                    <Link to={`/tasks/${dep.blocking_task_id}`} className={`hover:underline ${other?.status === "done" ? "text-gray-400 line-through" : "text-gray-800"}`}>
                      {other?.title ?? "Unknown task"}
                    </Link>
                    <button onClick={() => removeDependency.mutate(dep.id)} className="text-gray-400 hover:text-red-600">
                      &times;
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="mb-3">
            <p className="mb-1 text-xs font-semibold text-gray-600">Blocking</p>
            {blocking.length === 0 ? (
              <p className="text-xs text-gray-400">Not blocking any other task.</p>
            ) : (
              blocking.map((dep) => {
                const other = tasksById.get(dep.dependent_task_id);
                return (
                  <div key={dep.id} className="flex items-center justify-between rounded border border-gray-200 px-2 py-1 text-sm">
                    <Link to={`/tasks/${dep.dependent_task_id}`} className={`hover:underline ${other?.status === "done" ? "text-gray-400 line-through" : "text-gray-800"}`}>
                      {other?.title ?? "Unknown task"}
                    </Link>
                    <button onClick={() => removeDependency.mutate(dep.id)} className="text-gray-400 hover:text-red-600">
                      &times;
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <input
            type="text"
            placeholder="Search tasks to link..."
            value={dependencySearch}
            onChange={(e) => setDependencySearch(e.target.value)}
            className="mb-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-xs"
          />
          {dependencyError ? <p className="mb-1 text-xs text-red-600">{dependencyError}</p> : null}
          {dependencySearchResults.length > 0 ? (
            <div className="space-y-1 rounded border border-gray-200 p-1.5">
              {dependencySearchResults.map((t) => (
                <div key={t.id} className="flex items-center justify-between text-xs">
                  <span className="truncate">{t.title}</span>
                  <span className="flex flex-shrink-0 gap-2">
                    <button onClick={() => addDependency.mutate({ otherTaskId: t.id, direction: "blocked_by" })} className="font-semibold text-blue-700 hover:underline">
                      Blocked by
                    </button>
                    <button onClick={() => addDependency.mutate({ otherTaskId: t.id, direction: "blocking" })} className="font-semibold text-blue-700 hover:underline">
                      Blocking
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Subtasks</h2>
            {subtasks.length > 0 ? (
              <span className="text-xs font-semibold text-gray-400">
                {subtasks.filter((s) => s.status === "done").length}/{subtasks.length}
              </span>
            ) : null}
          </div>
          <div className="space-y-1">
            {subtasks.map((sub, i) => (
              <div key={sub.id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5">
                <input type="checkbox" checked={sub.status === "done"} onChange={(e) => toggleSubtask.mutate({ subtaskId: sub.id, done: e.target.checked })} />
                <Link to={`/tasks/${sub.id}`} className={`flex-1 truncate text-sm hover:underline ${sub.status === "done" ? "text-gray-400 line-through" : "text-gray-800"}`}>
                  {sub.title}
                </Link>
                <button disabled={i === 0} onClick={() => reorderSubtask(i, -1)} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30">
                  &uarr;
                </button>
                <button disabled={i === subtasks.length - 1} onClick={() => reorderSubtask(i, 1)} className="text-xs text-gray-400 hover:text-gray-700 disabled:opacity-30">
                  &darr;
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              placeholder="+ Add subtask"
              value={subtaskTitle}
              onChange={(e) => setSubtaskTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && subtaskTitle.trim() && addSubtask.mutate()}
              className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />
            <button
              onClick={() => addSubtask.mutate()}
              disabled={!subtaskTitle.trim() || addSubtask.isPending}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              Add
            </button>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Photos</h2>
            <label className="cursor-pointer rounded-md bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800">
              {uploadPhotos.isPending ? "Uploading..." : "+ Upload"}
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
          {photoError ? <p className="mb-2 text-xs text-red-600">{photoError}</p> : null}
          {!files || files.length === 0 ? (
            <p className="text-xs text-gray-500">No photos yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {files.map((f) => (
                <a key={f.id} href={fileUrls?.[f.id] || undefined} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded-md border border-gray-300 bg-gray-100">
                  {fileUrls?.[f.id] ? <img src={fileUrls[f.id]} alt={f.file_name} className="h-full w-full object-cover" /> : null}
                </a>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Activity & comments</h2>
          <div className="mb-3">
            <TextAreaField label="Add a comment" rows={2} value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
            {(profiles ?? []).length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1">
                {(profiles ?? []).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setNoteBody((body) => `${body}${body.endsWith(" ") || body === "" ? "" : " "}@${p.full_name} `)}
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-200"
                  >
                    @{p.full_name}
                  </button>
                ))}
              </div>
            ) : null}
            {noteError ? <p className="mb-2 text-xs text-red-600">{noteError}</p> : null}
            <button
              onClick={() => addNote.mutate()}
              disabled={addNote.isPending || !noteBody.trim()}
              className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {addNote.isPending ? "Adding..." : "Add comment"}
            </button>
          </div>
          <div className="space-y-2">
            {feed.map((item) =>
              item.kind === "note" ? (
                <div key={item.id} className="border-t border-gray-200 pt-2 text-sm">
                  <p className="text-gray-800">{item.note.body}</p>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {(item.note.author_id && profilesById.get(item.note.author_id)?.full_name) || "Unknown"} &middot;{" "}
                    {new Date(item.note.created_at).toLocaleString()}
                  </p>
                </div>
              ) : (
                <div key={item.id} className="border-t border-gray-100 pt-2 text-xs text-gray-500">
                  {activityLine(item.log, profilesById)} &middot; {new Date(item.log.created_at).toLocaleString()}
                </div>
              )
            )}
            {feed.length === 0 ? <p className="text-sm text-gray-500">No activity yet.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
