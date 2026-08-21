import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useMatch } from "react-router-dom";
import {
  createTaskProjectSchema,
  createTaskSchema,
  createTaskSectionSchema,
  type JobCard,
  type Profile,
  type Task,
  type TaskDependency,
  type TaskPriority,
  type TaskProject,
  type TaskProjectViewType,
  type TaskSection,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { Modal } from "../components/Modal";
import { FormField, SelectField, TextAreaField } from "../components/FormField";
import { BoardView } from "../components/tasks/BoardView";
import { ListView } from "../components/tasks/ListView";
import { CalendarView } from "../components/tasks/CalendarView";
import { TimelineView } from "../components/tasks/TimelineView";
import { PRIORITY_LABELS, PRIORITY_ORDER, dependencyGuardrailMessage, isOverdue, toMap, unresolvedBlockers } from "../components/tasks/taskHelpers";

// Asana-style multi-view workspace - project selector sidebar, a view
// switcher (Board/List/Calendar/Timeline) that defaults to the selected
// project's own view_type, and quick filters. "All Tasks" (no project
// selected) only offers List/Calendar - Board and Timeline are inherently
// project-scoped (task_sections belong to one project; a cross-project
// Gantt of everything at once isn't a real workflow here), same reasoning
// task_sections.project_id being NOT NULL already encodes at the schema
// level.

const VIEW_TYPES: TaskProjectViewType[] = ["BOARD", "LIST", "CALENDAR", "TIMELINE"];
const VIEW_LABELS: Record<TaskProjectViewType, string> = { BOARD: "Board", LIST: "List", CALENDAR: "Calendar", TIMELINE: "Timeline" };

type QuickFilter = "all" | "mine" | "overdue" | "unassigned";

async function fetchProjects(): Promise<TaskProject[]> {
  const { data, error } = await supabase.from("task_projects").select("*").eq("is_archived", false).order("created_at");
  if (error) throw error;
  return data as TaskProject[];
}
async function fetchSections(projectId: string): Promise<TaskSection[]> {
  const { data, error } = await supabase.from("task_sections").select("*").eq("project_id", projectId).order("position_order");
  if (error) throw error;
  return data as TaskSection[];
}
async function fetchAllTasks(): Promise<Task[]> {
  const { data, error } = await supabase.from("tasks").select("*").order("position_order");
  if (error) throw error;
  return data as Task[];
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
async function fetchDependencies(): Promise<TaskDependency[]> {
  const { data, error } = await supabase.from("task_dependencies").select("*");
  if (error) throw error;
  return data as TaskDependency[];
}

export default function TasksPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const drawerMatch = useMatch("/tasks/:id");

  const { data: projects } = useQuery({ queryKey: ["task-projects"], queryFn: fetchProjects });
  const { data: allTasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: fetchAllTasks });
  const { data: profiles } = useQuery({ queryKey: ["profiles"], queryFn: fetchProfiles });
  const { data: jobCards } = useQuery({ queryKey: ["job-cards-min"], queryFn: fetchJobCards });
  const { data: dependencies } = useQuery({ queryKey: ["task-dependencies"], queryFn: fetchDependencies });

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const selectedProject = (projects ?? []).find((p) => p.id === selectedProjectId) ?? null;

  const { data: sections } = useQuery({
    queryKey: ["task-sections", selectedProjectId],
    queryFn: () => fetchSections(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  const [viewType, setViewType] = useState<TaskProjectViewType>("LIST");
  useEffect(() => {
    setViewType(selectedProject ? selectedProject.view_type : "LIST");
  }, [selectedProjectId]);

  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "">("");
  const [search, setSearch] = useState("");

  const profilesById = toMap(profiles);
  const jobCardsById = toMap(jobCards);

  const scopedTasks = useMemo(() => {
    if (!allTasks) return [];
    return allTasks.filter((t) => (selectedProjectId ? t.project_id === selectedProjectId : true));
  }, [allTasks, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    const trimmedSearch = search.trim().toLowerCase();
    return scopedTasks.filter((t) => {
      if (quickFilter === "mine" && t.assigned_to !== profile?.id) return false;
      if (quickFilter === "overdue" && !isOverdue(t)) return false;
      if (quickFilter === "unassigned" && t.assigned_to) return false;
      if (priorityFilter && t.priority !== priorityFilter) return false;
      if (trimmedSearch && !t.title.toLowerCase().includes(trimmedSearch)) return false;
      return true;
    });
  }, [scopedTasks, quickFilter, priorityFilter, search, profile?.id]);

  // --- New Project ---
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectViewType, setProjectViewType] = useState<TaskProjectViewType>("BOARD");
  const [projectError, setProjectError] = useState<string | null>(null);

  const createProject = useMutation({
    mutationFn: async () => {
      const result = createTaskProjectSchema.safeParse({ name: projectName, view_type: projectViewType });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid project");
      if (!profile) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("task_projects")
        .insert({ tenant_id: profile.tenant_id, name: result.data.name, view_type: result.data.view_type, created_by: profile.id })
        .select()
        .single();
      if (error) throw error;
      return data as TaskProject;
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["task-projects"] });
      setSelectedProjectId(project.id);
      setProjectModalOpen(false);
      setProjectName("");
      setProjectError(null);
    },
    onError: (e) => setProjectError(getErrorMessage(e, "Failed to create project")),
  });

  // --- New Section ---
  const [sectionModalOpen, setSectionModalOpen] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [sectionError, setSectionError] = useState<string | null>(null);

  const createSection = useMutation({
    mutationFn: async () => {
      if (!selectedProjectId) throw new Error("Select a project first");
      const positionOrder = (sections ?? []).length;
      const result = createTaskSectionSchema.safeParse({ project_id: selectedProjectId, name: sectionName, position_order: positionOrder });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid section");
      if (!profile) throw new Error("Not signed in");
      const { error } = await supabase
        .from("task_sections")
        .insert({ tenant_id: profile.tenant_id, project_id: result.data.project_id, name: result.data.name, position_order: result.data.position_order });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-sections", selectedProjectId] });
      setSectionModalOpen(false);
      setSectionName("");
      setSectionError(null);
    },
    onError: (e) => setSectionError(getErrorMessage(e, "Failed to create section")),
  });

  // --- New Task ---
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskPriority, setTaskPriority] = useState<TaskPriority>("medium");
  const [taskSectionId, setTaskSectionId] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);

  const resetTaskForm = () => {
    setTaskTitle("");
    setTaskDescription("");
    setTaskDueDate("");
    setTaskAssignee("");
    setTaskPriority("medium");
    setTaskSectionId("");
    setTaskError(null);
  };

  const createTask = useMutation({
    mutationFn: async () => {
      const result = createTaskSchema.safeParse({
        title: taskTitle,
        description: taskDescription || undefined,
        due_date: taskDueDate || undefined,
        assigned_to: taskAssignee || undefined,
        priority: taskPriority,
        project_id: selectedProjectId ?? undefined,
        section_id: taskSectionId || undefined,
      });
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
          assigned_to: result.data.assigned_to || null,
          priority: result.data.priority,
          project_id: result.data.project_id || null,
          section_id: result.data.section_id || null,
          created_by: profile.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as Task;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      resetTaskForm();
      setTaskModalOpen(false);
    },
    onError: (e) => setTaskError(getErrorMessage(e, "Failed to create task")),
  });

  const updateTask = useMutation({
    mutationFn: async ({ taskId, patch }: { taskId: string; patch: Partial<Task> }) => {
      const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const tasksById = toMap(allTasks);
  // Dependency guardrail - applies wherever a task can be marked complete
  // (not just the drawer's own Complete button), so completing a task from
  // the List view's inline status control can't bypass the warning.
  const guardedUpdateTask = (taskId: string, patch: Partial<Task>) => {
    if (patch.status === "done") {
      const blockers = unresolvedBlockers(taskId, dependencies ?? [], tasksById);
      if (blockers.length > 0 && !window.confirm(dependencyGuardrailMessage(blockers))) return;
    }
    updateTask.mutate({ taskId, patch });
  };

  return (
    <div className="flex h-full">
      <div className="w-56 flex-shrink-0 border-r border-gray-300 bg-gray-50 p-4">
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-400">Projects</p>
        <button
          onClick={() => setSelectedProjectId(null)}
          className={`mb-1 w-full rounded-md px-3 py-1.5 text-left text-sm font-semibold ${
            selectedProjectId === null ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-200"
          }`}
        >
          All Tasks
        </button>
        {(projects ?? []).map((project) => (
          <button
            key={project.id}
            onClick={() => setSelectedProjectId(project.id)}
            className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm font-semibold ${
              selectedProjectId === project.id ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-200"
            }`}
          >
            <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: project.color_hex }} />
            <span className="truncate">{project.name}</span>
          </button>
        ))}
        <button onClick={() => setProjectModalOpen(true)} className="mt-2 w-full text-left text-sm font-semibold text-blue-700 hover:underline">
          + New Project
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-bold text-gray-900">{selectedProject?.name ?? "All Tasks"}</h1>
          <div className="flex gap-2">
            {selectedProjectId && viewType === "BOARD" ? (
              <button
                onClick={() => setSectionModalOpen(true)}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                + New Section
              </button>
            ) : null}
            <button
              onClick={() => setTaskModalOpen(true)}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              + New Task
            </button>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {(selectedProjectId ? VIEW_TYPES : (["LIST", "CALENDAR"] as TaskProjectViewType[])).map((v) => (
            <button
              key={v}
              onClick={() => setViewType(v)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${viewType === v ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(["all", "mine", "overdue", "unassigned"] as QuickFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setQuickFilter(f)}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold ${quickFilter === f ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {f === "all" ? "All" : f === "mine" ? "My Tasks" : f === "overdue" ? "Overdue" : "Unassigned"}
            </button>
          ))}
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as TaskPriority | "")}
            className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All priorities</option>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : viewType === "BOARD" && selectedProjectId ? (
            <BoardView
              sections={sections ?? []}
              tasks={filteredTasks}
              allTasks={allTasks ?? []}
              profilesById={profilesById}
              jobCardsById={jobCardsById}
              onMoveTask={({ taskId, sectionId, positionOrder }) =>
                updateTask.mutate({ taskId, patch: { section_id: sectionId, position_order: positionOrder } })
              }
            />
          ) : viewType === "CALENDAR" ? (
            <CalendarView tasks={filteredTasks} />
          ) : viewType === "TIMELINE" && selectedProjectId ? (
            <TimelineView tasks={filteredTasks} dependencies={dependencies ?? []} />
          ) : (
            <ListView
              groupBy={selectedProjectId ? "section" : "priority"}
              sections={sections ?? []}
              tasks={filteredTasks}
              profiles={profiles ?? []}
              jobCardsById={jobCardsById}
              onUpdateTask={guardedUpdateTask}
            />
          )}
        </div>
      </div>

      {drawerMatch ? (
        <div className="fixed inset-y-0 right-0 z-40 w-full max-w-lg overflow-y-auto border-l border-gray-300 bg-white shadow-2xl">
          <Outlet />
        </div>
      ) : null}

      <Modal open={projectModalOpen} onClose={() => setProjectModalOpen(false)} title="New project">
        <FormField label="Name" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        <SelectField
          label="Default view"
          value={projectViewType}
          onChange={(v) => setProjectViewType((v || "BOARD") as TaskProjectViewType)}
          options={VIEW_TYPES.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
        />
        {projectError ? <p className="mb-4 text-sm text-red-600">{projectError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setProjectModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createProject.mutate()}
            disabled={createProject.isPending || !projectName.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createProject.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal open={sectionModalOpen} onClose={() => setSectionModalOpen(false)} title="New section">
        <FormField label="Name" value={sectionName} onChange={(e) => setSectionName(e.target.value)} />
        {sectionError ? <p className="mb-4 text-sm text-red-600">{sectionError}</p> : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setSectionModalOpen(false)} className="px-4 py-2 text-sm font-semibold text-gray-600">
            Cancel
          </button>
          <button
            onClick={() => createSection.mutate()}
            disabled={createSection.isPending || !sectionName.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createSection.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>

      <Modal
        open={taskModalOpen}
        onClose={() => {
          setTaskModalOpen(false);
          resetTaskForm();
        }}
        title="New task"
      >
        <FormField label="Title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
        <TextAreaField label="Description (optional)" rows={3} value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} />
        {selectedProjectId && (sections ?? []).length > 0 ? (
          <SelectField
            label="Section"
            value={taskSectionId}
            onChange={(v) => setTaskSectionId(v)}
            placeholder="No section"
            options={(sections ?? []).map((s) => ({ value: s.id, label: s.name }))}
          />
        ) : null}
        <SelectField
          label="Assignee"
          value={taskAssignee}
          onChange={(v) => setTaskAssignee(v)}
          placeholder="Unassigned"
          options={(profiles ?? []).map((p) => ({ value: p.id, label: p.full_name }))}
        />
        <FormField label="Due date (optional)" type="date" value={taskDueDate} onChange={(e) => setTaskDueDate(e.target.value)} />
        <SelectField
          label="Priority"
          value={taskPriority}
          onChange={(v) => setTaskPriority((v || "medium") as TaskPriority)}
          options={PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
        />
        {taskError ? <p className="mb-4 text-sm text-red-600">{taskError}</p> : null}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => {
              setTaskModalOpen(false);
              resetTaskForm();
            }}
            className="px-4 py-2 text-sm font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            onClick={() => createTask.mutate()}
            disabled={createTask.isPending || !taskTitle.trim()}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {createTask.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
