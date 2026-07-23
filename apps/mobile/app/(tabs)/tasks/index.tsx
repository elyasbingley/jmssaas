import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createTaskSchema, type Task, type TaskStatus } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { CenteredModal } from "../../../components/CenteredModal";
import { FormField } from "../../../components/FormField";
import { DateField } from "../../../components/DateField";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

type StatusFilter = TaskStatus | "all";

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

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const filteredTasks = useMemo(
    () => (statusFilter === "all" ? tasks : tasks.filter((t) => t.status === statusFilter)),
    [tasks, statusFilter]
  );

  const [modalVisible, setModalVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setDueDate(null);
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createTaskSchema.safeParse({
      title,
      description,
      due_date: toDateInput(dueDate),
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO tasks (id, tenant_id, title, description, status, due_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
      [
        uuidv4(),
        profile.tenant_id,
        result.data.title,
        result.data.description || null,
        result.data.due_date || null,
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
                <Text style={styles.rowTitle}>{item.title}</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 12 },
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
    borderBottomColor: "#f0f0f0",
  },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowNumber: { fontSize: 12, fontWeight: "700", color: "#1d4ed8" },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { color: "#6b7280", marginTop: 2 },
  statusBadge: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
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
});
