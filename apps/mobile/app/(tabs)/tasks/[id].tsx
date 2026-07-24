import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createTaskNoteSchema, createTaskSchema, type Task, type TaskNote, type TaskStatus } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { addTaskPhoto } from "../../../lib/powersync";
import { CenteredModal } from "../../../components/CenteredModal";
import { FormField } from "../../../components/FormField";
import { DateField } from "../../../components/DateField";
import { PhotoAttachments } from "../../../components/PhotoAttachments";

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateInput(d: Date | null): string {
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const STATUSES: TaskStatus[] = ["todo", "in_progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

interface TaskFileWithLocalUri {
  id: string;
  local_uri: string | null;
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();

  const { data: taskRows } = useQuery<Task>("SELECT * FROM tasks WHERE id = ?", [id]);
  const task = taskRows[0];

  const { data: notes } = useQuery<TaskNote>(
    "SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at DESC",
    [id]
  );

  const { data: files } = useQuery<TaskFileWithLocalUri>(
    `SELECT tf.id, a.local_uri
       FROM task_files tf
       LEFT JOIN attachments a ON a.id = tf.id
      WHERE tf.task_id = ?
      ORDER BY tf.created_at DESC`,
    [id]
  );

  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleStatusChange = async (status: TaskStatus) => {
    await powersync.execute("UPDATE tasks SET status = ? WHERE id = ?", [status, id]);
  };

  // --- Edit task title/description/due date ---
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueDate, setEditDueDate] = useState<Date | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = () => {
    if (!task) return;
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditDueDate(parseDate(task.due_date ?? ""));
    setEditError(null);
    setEditModalVisible(true);
  };

  const handleSaveEdit = async () => {
    const result = createTaskSchema.safeParse({
      title: editTitle,
      description: editDescription,
      job_card_id: task?.job_card_id ?? undefined,
      assigned_to: task?.assigned_to ?? undefined,
      due_date: toDateInput(editDueDate) || undefined,
    });
    if (!result.success) {
      setEditError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }

    await powersync.execute(
      "UPDATE tasks SET title = ?, description = ?, due_date = ?, updated_at = ? WHERE id = ?",
      [result.data.title, result.data.description || null, result.data.due_date || null, new Date().toISOString(), id]
    );
    setEditModalVisible(false);
  };

  const handleDelete = () => {
    Alert.alert("Delete task", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("DELETE FROM tasks WHERE id = ?", [id]);
          router.back();
        },
      },
    ]);
  };

  const handleAddNote = async () => {
    const result = createTaskNoteSchema.safeParse({ task_id: id, body: noteText });
    if (!result.success) {
      setNoteError(result.error.issues[0]?.message ?? "Note can't be empty");
      return;
    }
    if (!profile) return;

    await powersync.execute(
      "INSERT INTO task_notes (id, tenant_id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), profile.tenant_id, id, profile.id, result.data.body, new Date().toISOString()]
    );
    setNoteText("");
    setNoteError(null);
  };

  const handleUploadPhoto = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile) return;
    setUploading(true);
    try {
      await addTaskPhoto({
        tenantId: profile.tenant_id,
        taskId: id,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(photo.base64),
        mediaType: photo.mimeType,
        fileExtension: photo.fileExtension,
      });
    } finally {
      setUploading(false);
    }
  };

  if (!task) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <>
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.section}>
        <View style={styles.titleRow}>
          <Text style={styles.number}>{task.number ?? "Pending sync"}</Text>
          <Pressable onPress={openEditModal}>
            <Text style={styles.link}>Edit</Text>
          </Pressable>
        </View>
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
          <Pressable onPress={() => router.push(`/sales/jobs/${task.job_card_id}`)}>
            <Text style={styles.link}>View linked job</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Photos</Text>
        <PhotoAttachments photos={files} uploading={uploading} onUpload={handleUploadPhoto} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        <FormField label="Add a note" placeholder="Note" value={noteText} onChangeText={setNoteText} multiline style={styles.multiline} />
        {noteError ? <Text style={styles.error}>{noteError}</Text> : null}
        <Pressable style={[styles.button, styles.addNoteButton]} onPress={handleAddNote}>
          <Text style={styles.buttonText}>Add note</Text>
        </Pressable>

        {notes.map((note) => (
          <View key={note.id} style={styles.noteRow}>
            <Text style={styles.noteBody}>{note.body}</Text>
            <Text style={styles.noteMeta}>{new Date(note.created_at).toLocaleString()}</Text>
          </View>
        ))}
      </View>

      {profile?.role === "admin" ? (
        <View style={styles.section}>
          <Pressable style={styles.deleteButton} onPress={handleDelete}>
            <Text style={styles.deleteButtonText}>Delete task</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>

    <CenteredModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
      <Text style={styles.modalTitle}>Edit task</Text>
      <FormField label="Title" placeholder="Task title" value={editTitle} onChangeText={setEditTitle} />
      <FormField
        label="Description (optional)"
        placeholder="Description"
        value={editDescription}
        onChangeText={setEditDescription}
        multiline
        style={styles.multiline}
      />
      <View style={styles.fieldSpacing}>
        <DateField label="Due date (optional)" value={editDueDate} onChange={setEditDueDate} mode="date" />
      </View>
      {editError ? <Text style={styles.error}>{editError}</Text> : null}
      <View style={styles.modalActions}>
        <Pressable onPress={() => setEditModalVisible(false)}>
          <Text style={styles.link}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={handleSaveEdit}>
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
      </View>
    </CenteredModal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  section: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb" },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  number: { fontSize: 12, fontWeight: "700", color: "#1d4ed8", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: "700" },
  description: { marginTop: 6, color: "#374151" },
  meta: { marginTop: 8, color: "#6b7280" },
  fieldSpacing: { marginTop: 16 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginBottom: 10 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600" },
  statusChipTextActive: { color: "#fff" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  addNoteButton: { alignSelf: "flex-start", marginTop: 10 },
  error: { color: "#dc2626", marginTop: 6 },
  noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0f0f0" },
  noteBody: { fontSize: 15, color: "#111827" },
  noteMeta: { fontSize: 12, color: "#9ca3af", marginTop: 4 },
  empty: { textAlign: "center", color: "#6b7280", padding: 24 },
  deleteButton: { borderRadius: 8, padding: 14, alignItems: "center", backgroundColor: "#fef2f2" },
  deleteButtonText: { color: "#dc2626", fontWeight: "700" },
});
