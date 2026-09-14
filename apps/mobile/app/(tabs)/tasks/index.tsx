import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createTaskSchema, type Profile, type Task, type TaskPriority, type TaskProject, type TaskSection, type TaskStatus } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { CenteredModal } from "../../../components/CenteredModal";
import { FormField } from "../../../components/FormField";
import { DateField } from "../../../components/DateField";
import { PickerModal } from "../../../components/PickerModal";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_LABELS: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

type StatusFilter = TaskStatus | "all";
type QuickFilter = "all" | "mine" | "due_today";

function toDateInput(d: Date | null): string | undefined {
  if (!d) return undefined;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TasksScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  // Every device syncs the whole tenant's tasks table (see
  // powersync/sync-rules.yaml), so unlike Postgres RLS this local query has
  // to apply the "assigned to me" restriction itself for technicians.
  const { data: tasks } = useQuery<Task>(
    isAdmin
      ? "SELECT * FROM tasks ORDER BY (due_date IS NULL), due_date, created_at DESC"
      : "SELECT * FROM tasks WHERE assigned_to = ? ORDER BY (due_date IS NULL), due_date, created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );
  const { data: projects } = useQuery<TaskProject>("SELECT * FROM task_projects ORDER BY name");
  const { data: profiles } = useQuery<Profile>("SELECT * FROM profiles ORDER BY full_name");

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { data: sections } = useQuery<TaskSection>(
    "SELECT * FROM task_sections WHERE project_id = ? ORDER BY position_order",
    [selectedProjectId ?? ""]
  );
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");

  const todayStr = toDateInput(new Date());

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (selectedProjectId && t.project_id !== selectedProjectId) return false;
      if (selectedSectionId && t.section_id !== selectedSectionId) return false;
      if (quickFilter === "mine" && t.assigned_to !== profile?.id) return false;
      if (quickFilter === "due_today" && t.due_date !== todayStr) return false;
      return true;
    });
  }, [tasks, statusFilter, selectedProjectId, selectedSectionId, quickFilter, profile?.id, todayStr]);

  const [modalVisible, setModalVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [isMilestone, setIsMilestone] = useState(false);
  const [assignee, setAssignee] = useState<Profile | null>(null);
  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setDueDate(null);
    setPriority("medium");
    setIsMilestone(false);
    setAssignee(null);
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createTaskSchema.safeParse({
      title,
      description,
      due_date: toDateInput(dueDate),
      priority,
      is_milestone: isMilestone,
      assigned_to: assignee?.id,
      project_id: selectedProjectId ?? undefined,
      section_id: selectedSectionId ?? undefined,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO tasks (id, tenant_id, title, description, status, due_date, priority, is_milestone, assigned_to, project_id, section_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        profile.tenant_id,
        result.data.title,
        result.data.description || null,
        result.data.due_date || null,
        result.data.priority,
        result.data.is_milestone ? 1 : 0,
        result.data.assigned_to || null,
        result.data.project_id || null,
        result.data.section_id || null,
        profile.id,
        now,
        now,
      ]
    );

    resetForm();
    setModalVisible(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        <Pressable
          style={[styles.filterChip, selectedProjectId === null && styles.filterChipActive]}
          onPress={() => {
            setSelectedProjectId(null);
            setSelectedSectionId(null);
          }}
        >
          <Text style={[styles.filterChipText, selectedProjectId === null && styles.filterChipTextActive]}>All Projects</Text>
        </Pressable>
        {projects.map((project) => (
          <Pressable
            key={project.id}
            style={[styles.filterChip, selectedProjectId === project.id && styles.filterChipActive]}
            onPress={() => {
              setSelectedProjectId(project.id);
              setSelectedSectionId(null);
            }}
          >
            <Text style={[styles.filterChipText, selectedProjectId === project.id && styles.filterChipTextActive]}>{project.name}</Text>
          </Pressable>
        ))}
      </View>

      {selectedProjectId && sections.length > 0 ? (
        <View style={styles.filterRow}>
          <Pressable
            style={[styles.filterChip, selectedSectionId === null && styles.filterChipActive]}
            onPress={() => setSelectedSectionId(null)}
          >
            <Text style={[styles.filterChipText, selectedSectionId === null && styles.filterChipTextActive]}>All sections</Text>
          </Pressable>
          {sections.map((section) => (
            <Pressable
              key={section.id}
              style={[styles.filterChip, selectedSectionId === section.id && styles.filterChipActive]}
              onPress={() => setSelectedSectionId(section.id)}
            >
              <Text style={[styles.filterChipText, selectedSectionId === section.id && styles.filterChipTextActive]}>{section.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.filterRow}>
        {(["all", "mine", "due_today"] as QuickFilter[]).map((f) => (
          <Pressable key={f} style={[styles.filterChip, quickFilter === f && styles.filterChipActive]} onPress={() => setQuickFilter(f)}>
            <Text style={[styles.filterChipText, quickFilter === f && styles.filterChipTextActive]}>
              {f === "all" ? "All" : f === "mine" ? "My Tasks" : "Due Today"}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.filterRow}>
        {(["all", ...STATUSES] as StatusFilter[]).map((status) => (
          <Pressable
            key={status}
            style={[styles.filterChip, statusFilter === status && styles.filterChipActive]}
            onPress={() => setStatusFilter(status)}
          >
            <Text style={[styles.filterChipText, statusFilter === status && styles.filterChipTextActive]}>
              {status === "all" ? "All" : STATUS_LABELS[status]}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filteredTasks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/tasks/${item.id}`)}>
            <View style={{ flex: 1 }}>
              <View style={styles.rowTitleRow}>
                <Text style={styles.rowNumber}>{item.number ?? "Pending sync"}</Text>
                <Text style={styles.rowTitle}>
                  {item.is_milestone ? "🔶 " : ""}
                  {item.title}
                </Text>
              </View>
              {item.due_date ? <Text style={styles.rowSubtitle}>Due {item.due_date}</Text> : null}
            </View>
            <Text style={styles.statusBadge}>{STATUS_LABELS[item.status]}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No tasks here.</Text>}
        contentContainerStyle={filteredTasks.length === 0 ? styles.emptyContainer : undefined}
      />

      {isAdmin ? (
        <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
          <Text style={styles.fabText}>+ New task</Text>
        </Pressable>
      ) : null}

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          resetForm();
        }}
      >
        <Text style={styles.modalTitle}>New task</Text>
        <FormField label="Title" placeholder="Task title" value={title} onChangeText={setTitle} />
        <FormField
          label="Description (optional)"
          placeholder="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.multiline}
        />
        <DateField label="Due date (optional)" value={dueDate} onChange={setDueDate} mode="date" placeholder="No due date" />

        <Text style={styles.fieldLabel}>Priority</Text>
        <View style={styles.priorityRow}>
          {PRIORITIES.map((p) => (
            <Pressable key={p} style={[styles.priorityChip, priority === p && styles.filterChipActive]} onPress={() => setPriority(p)}>
              <Text style={[styles.filterChipText, priority === p && styles.filterChipTextActive]}>{PRIORITY_LABELS[p]}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable style={styles.assigneeRow} onPress={() => setAssigneePickerVisible(true)}>
          <Text style={styles.fieldLabel}>Assignee</Text>
          <Text style={styles.link}>{assignee?.full_name ?? "Unassigned"}</Text>
        </Pressable>

        <View style={styles.switchRow}>
          <Text style={styles.fieldLabel}>Milestone</Text>
          <Switch value={isMilestone} onValueChange={setIsMilestone} />
        </View>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable
            onPress={() => {
              setModalVisible(false);
              resetForm();
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleCreate}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <PickerModal
        visible={assigneePickerVisible}
        title="Select assignee"
        items={[null, ...profiles]}
        getKey={(p) => p?.id ?? "none"}
        getLabel={(p) => p?.full_name ?? "Unassigned"}
        onSelect={setAssignee}
        onClose={() => setAssigneePickerVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingTop: 12 },
  filterChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: "#f3f4f6" },
  filterChipActive: { backgroundColor: "#111827" },
  filterChipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  filterChipTextActive: { color: "#fff" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowNumber: { fontSize: 12, fontWeight: "700", color: "#1d4ed8", flexShrink: 0 },
  rowTitle: { fontSize: 16, fontWeight: "600", flex: 1 },
  rowSubtitle: { color: "#6b7280", marginTop: 2 },
  statusBadge: { color: "#1d4ed8", fontWeight: "600", fontSize: 12, flexShrink: 0 },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 24,
    backgroundColor: "#1d4ed8",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fabText: { color: "#fff", fontWeight: "700" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
  fieldLabel: { fontWeight: "600", color: "#374151", marginTop: 10, marginBottom: 6 },
  priorityRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 6 },
  priorityChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: "#f3f4f6" },
  assigneeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 },
});
