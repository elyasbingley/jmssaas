import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createTaskSchema, type Task, type TaskStatus } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { AppNavBar } from "../../../components/AppNavBar";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

type StatusFilter = TaskStatus | "all";

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
  const [dueDate, setDueDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async () => {
    const result = createTaskSchema.safeParse({
      title,
      description,
      due_date: dueDate || undefined,
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

    setTitle("");
    setDescription("");
    setDueDate("");
    setFormError(null);
    setModalVisible(false);
  };

  return (
    <View style={styles.container}>
      <AppNavBar />

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
              <Text style={styles.rowTitle}>{item.title}</Text>
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

      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New task</Text>
            <TextInput style={styles.input} placeholder="Title" value={title} onChangeText={setTitle} />
            <TextInput
              style={[styles.input, styles.multiline]}
              placeholder="Description"
              value={description}
              onChangeText={setDescription}
              multiline
            />
            <TextInput
              style={styles.input}
              placeholder="Due date (YYYY-MM-DD)"
              value={dueDate}
              onChangeText={setDueDate}
            />
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => {
                  setModalVisible(false);
                  setFormError(null);
                }}
              >
                <Text style={styles.link}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.button} onPress={handleCreate}>
                <Text style={styles.buttonText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
