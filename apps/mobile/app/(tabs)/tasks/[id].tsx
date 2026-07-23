import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import type { Task, TaskStatus } from "@jmssaas/shared";

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();

  const { data: taskRows } = useQuery<Task>("SELECT * FROM tasks WHERE id = ?", [id]);
  const task = taskRows[0];

  const handleStatusChange = async (status: TaskStatus) => {
    await powersync.execute("UPDATE tasks SET status = ? WHERE id = ?", [status, id]);
  };

  if (!task) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.section}>
        <Text style={styles.title}>{task.title}</Text>
        {task.description ? <Text style={styles.description}>{task.description}</Text> : null}
        {task.due_date ? <Text style={styles.meta}>Due {task.due_date}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Status</Text>
        <View style={styles.statusRow}>
          {STATUSES.map((status) => (
            <Pressable
              key={status}
              style={[styles.statusChip, task.status === status && styles.statusChipActive]}
              onPress={() => handleStatusChange(status)}
            >
              <Text style={[styles.statusChipText, task.status === status && styles.statusChipTextActive]}>
                {STATUS_LABELS[status]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {task.job_card_id ? (
        <View style={styles.section}>
          <Pressable onPress={() => router.push(`/jobs/${task.job_card_id}`)}>
            <Text style={styles.link}>View linked job card</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  section: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb" },
  title: { fontSize: 20, fontWeight: "700" },
  description: { marginTop: 6, color: "#374151" },
  meta: { marginTop: 8, color: "#6b7280" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginBottom: 10 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600" },
  statusChipTextActive: { color: "#fff" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
});
