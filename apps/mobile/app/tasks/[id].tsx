import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createTaskNoteSchema,
  createTaskSchema,
  type Profile,
  type Task,
  type TaskNote,
  type TaskPriority,
  type TaskStatus,
} from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { addTaskPhoto } from "../../lib/powersync";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedModal } from "../../components/theme/ThemedModal";
import { ThemedFormField } from "../../components/theme/ThemedFormField";
import { ThemedDateField } from "../../components/theme/ThemedDateField";
import { ThemedPickerModal } from "../../components/theme/ThemedPickerModal";
import { ThemedButton } from "../../components/theme/ThemedButton";
import { ThemedPhotoAttachments } from "../../components/theme/ThemedPhotoAttachments";

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
const PRIORITIES: TaskPriority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_LABELS: Record<TaskPriority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

interface TaskFileWithLocalUri {
  id: string;
  local_uri: string | null;
  file_name: string | null;
  mime_type: string | null;
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const styles = useThemedStyles(createStyles);

  const { data: taskRows } = useQuery<Task>("SELECT * FROM tasks WHERE id = ?", [id]);
  const task = taskRows[0];

  const { data: notes } = useQuery<TaskNote>(
    "SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at DESC",
    [id]
  );

  const { data: files } = useQuery<TaskFileWithLocalUri>(
    `SELECT tf.id, tf.file_name, tf.mime_type, a.local_uri
       FROM task_files tf
       LEFT JOIN attachments a ON a.id = tf.id
      WHERE tf.task_id = ?
      ORDER BY tf.created_at DESC`,
    [id]
  );

  const { data: subtasks } = useQuery<Task>("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY position_order", [id]);
  const { data: profiles } = useQuery<Profile>("SELECT * FROM profiles ORDER BY full_name");
  const assignedProfile = profiles.find((p) => p.id === task?.assigned_to) ?? null;

  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleStatusChange = async (status: TaskStatus) => {
    await powersync.execute("UPDATE tasks SET status = ? WHERE id = ?", [status, id]);
  };

  const [assigneePickerVisible, setAssigneePickerVisible] = useState(false);
  const handleAssigneeChange = async (p: Profile | null) => {
    await powersync.execute("UPDATE tasks SET assigned_to = ? WHERE id = ?", [p?.id ?? null, id]);
  };

  const handlePriorityChange = async (priority: TaskPriority) => {
    await powersync.execute("UPDATE tasks SET priority = ? WHERE id = ?", [priority, id]);
  };

  // --- Edit task title/description/dates ---
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueDate, setEditDueDate] = useState<Date | null>(null);
  const [editStartDate, setEditStartDate] = useState<Date | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = () => {
    if (!task) return;
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
    setEditDueDate(parseDate(task.due_date ?? ""));
    setEditStartDate(parseDate(task.start_date ?? ""));
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
      start_date: toDateInput(editStartDate) || undefined,
    });
    if (!result.success) {
      setEditError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }

    await powersync.execute(
      "UPDATE tasks SET title = ?, description = ?, due_date = ?, start_date = ?, updated_at = ? WHERE id = ?",
      [result.data.title, result.data.description || null, result.data.due_date || null, result.data.start_date || null, new Date().toISOString(), id]
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

  const [subtaskTitle, setSubtaskTitle] = useState("");
  const handleAddSubtask = async () => {
    if (!subtaskTitle.trim() || !profile || !task) return;
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO tasks (id, tenant_id, title, status, parent_task_id, project_id, section_id, position_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), profile.tenant_id, subtaskTitle.trim(), id, task.project_id, task.section_id, subtasks.length, profile.id, now, now]
    );
    setSubtaskTitle("");
  };
  const handleToggleSubtask = async (subtaskId: string, done: boolean) => {
    await powersync.execute("UPDATE tasks SET status = ? WHERE id = ?", [done ? "done" : "todo", subtaskId]);
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
        <StatusBar style="light" />
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.section}>
          <View style={styles.titleRow}>
            <Pressable onPress={() => router.back()} hitSlop={8}>
              <Text style={styles.link}>‹ Back</Text>
            </Pressable>
            <Text style={styles.number}>{task.number ?? "Pending sync"}</Text>
            <Pressable onPress={openEditModal}>
              <Text style={styles.link}>Edit</Text>
            </Pressable>
          </View>
          <Text style={styles.title}>
            {task.is_milestone ? "🔶 " : ""}
            {task.title}
          </Text>
          {task.description ? <Text style={styles.description}>{task.description}</Text> : null}
          {task.start_date ? <Text style={styles.meta}>Starts {task.start_date}</Text> : null}
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

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Priority</Text>
          <View style={styles.statusRow}>
            {PRIORITIES.map((p) => (
              <Pressable key={p} style={[styles.statusChip, task.priority === p && styles.statusChipActive]} onPress={() => handlePriorityChange(p)}>
                <Text style={[styles.statusChipText, task.priority === p && styles.statusChipTextActive]}>{PRIORITY_LABELS[p]}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <Pressable style={styles.assigneeRow} onPress={() => setAssigneePickerVisible(true)}>
            <Text style={styles.sectionTitle}>Assignee</Text>
            <Text style={styles.link}>{assignedProfile?.full_name ?? "Unassigned"}</Text>
          </Pressable>
        </View>

        {task.job_card_id ? (
          <View style={styles.section}>
            <Pressable onPress={() => router.push(`/jobs/${task.job_card_id}`)}>
              <Text style={styles.link}>View linked job</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.section}>
          <View style={styles.titleRow}>
            <Text style={styles.sectionTitle}>Subtasks</Text>
            {subtasks.length > 0 ? (
              <Text style={styles.meta}>
                {subtasks.filter((s) => s.status === "done").length}/{subtasks.length}
              </Text>
            ) : null}
          </View>
          {subtasks.map((sub) => (
            <Pressable key={sub.id} style={styles.subtaskRow} onPress={() => router.push(`/tasks/${sub.id}`)}>
              <Pressable
                style={[styles.checkbox, sub.status === "done" && styles.checkboxChecked]}
                onPress={(e) => {
                  e.stopPropagation();
                  handleToggleSubtask(sub.id, sub.status !== "done");
                }}
              >
                {sub.status === "done" ? <Text style={styles.checkboxMark}>✓</Text> : null}
              </Pressable>
              <Text style={[styles.subtaskTitle, sub.status === "done" && styles.subtaskTitleDone]}>{sub.title}</Text>
            </Pressable>
          ))}
          <View style={styles.addSubtaskRow}>
            <TextInput
              style={styles.subtaskInput}
              placeholder="+ Add subtask"
              placeholderTextColor={styles.subtaskInputPlaceholder.color}
              value={subtaskTitle}
              onChangeText={setSubtaskTitle}
              onSubmitEditing={handleAddSubtask}
            />
            <ThemedButton label="Add" onPress={handleAddSubtask} />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Photos</Text>
          <ThemedPhotoAttachments photos={files} uploading={uploading} onUpload={handleUploadPhoto} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <ThemedFormField label="Add a note" placeholder="Note" value={noteText} onChangeText={setNoteText} multiline style={styles.multiline} />
          {noteError ? <Text style={styles.error}>{noteError}</Text> : null}
          <View style={styles.addNoteButton}>
            <ThemedButton label="Add note" onPress={handleAddNote} />
          </View>

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
              <Text style={styles.deleteButtonText}>Delete Task</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
      </SafeAreaView>

      <ThemedModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit Task</Text>
        <ThemedFormField label="Title" placeholder="Task title" value={editTitle} onChangeText={setEditTitle} />
        <ThemedFormField
          label="Description (optional)"
          placeholder="Description"
          value={editDescription}
          onChangeText={setEditDescription}
          multiline
          style={styles.multiline}
        />
        <View style={styles.fieldSpacing}>
          <ThemedDateField label="Start date (optional)" value={editStartDate} onChange={setEditStartDate} mode="date" />
        </View>
        <View style={styles.fieldSpacing}>
          <ThemedDateField label="Due date (optional)" value={editDueDate} onChange={setEditDueDate} mode="date" />
        </View>
        {editError ? <Text style={styles.error}>{editError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setEditModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleSaveEdit} />
        </View>
      </ThemedModal>

      <ThemedPickerModal
        visible={assigneePickerVisible}
        title="Select assignee"
        items={[null, ...profiles]}
        getKey={(p) => p?.id ?? "none"}
        getLabel={(p) => p?.full_name ?? "Unassigned"}
        onSelect={handleAssigneeChange}
        onClose={() => setAssigneePickerVisible(false)}
      />
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    container: { flex: 1, backgroundColor: tokens.background },
    section: { padding: 16, borderBottomWidth: 1, borderBottomColor: tokens.border },
    titleRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    number: { fontSize: font.label, fontWeight: "700" as const, color: tokens.accent, marginBottom: 2, letterSpacing: 1, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    description: { marginTop: 6, color: tokens.textPrimary, ...mono },
    meta: { marginTop: 8, color: tokens.textMuted, fontSize: font.label, ...mono },
    fieldSpacing: { marginTop: 16 },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    sectionTitle: {
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 10,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      fontSize: font.label,
      ...mono,
    },
    statusRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface },
    statusChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    statusChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.body - 1, ...mono },
    statusChipTextActive: { color: tokens.accent },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    multiline: { minHeight: 70, textAlignVertical: "top" as const },
    error: { color: tokens.danger, marginTop: 6, ...mono },
    noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: tokens.border },
    noteBody: { fontSize: font.body, color: tokens.textPrimary, ...mono },
    noteMeta: { fontSize: font.label, color: tokens.textMuted, marginTop: 4, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 24, ...mono },
    addNoteButton: { alignSelf: "flex-start" as const, marginTop: 10 },
    deleteButton: { borderRadius: 3, padding: 14, alignItems: "center" as const, borderWidth: 1, borderColor: tokens.danger },
    deleteButtonText: { color: tokens.danger, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    assigneeRow: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const },
    subtaskRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingVertical: 8 },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: tokens.border,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    checkboxChecked: { backgroundColor: tokens.accent, borderColor: tokens.accent },
    checkboxMark: { color: tokens.background, fontWeight: "700" as const, fontSize: 13 },
    subtaskTitle: { fontSize: font.body, color: tokens.textPrimary, flex: 1, ...mono },
    subtaskTitleDone: { color: tokens.textMuted, textDecorationLine: "line-through" as const },
    addSubtaskRow: { flexDirection: "row" as const, gap: 8, marginTop: 10, alignItems: "center" as const },
    subtaskInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: font.body,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    subtaskInputPlaceholder: { color: tokens.textMuted },
  };
}
