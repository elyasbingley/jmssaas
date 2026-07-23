import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createJobNoteSchema,
  createTaskSchema,
  type Invoice,
  type JobCard,
  type JobNote,
  type JobStatus,
  type Quote,
  type Task,
  type TaskStatus,
} from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import { addJobPhoto } from "../../../lib/powersync";
import { FormField } from "../../../components/FormField";
import { PhotoAttachments } from "../../../components/PhotoAttachments";

const STATUSES: JobStatus[] = ["new", "scheduled", "in_progress", "completed", "invoiced"];
const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
const NEXT_TASK_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

interface JobFileWithLocalUri {
  id: string;
  local_uri: string | null;
}

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [id]);
  const job = jobRows[0];

  const { data: notes } = useQuery<JobNote>(
    "SELECT * FROM job_notes WHERE job_card_id = ? ORDER BY created_at DESC",
    [id]
  );

  const { data: jobTasks } = useQuery<Task>(
    "SELECT * FROM tasks WHERE job_card_id = ? ORDER BY (due_date IS NULL), due_date, created_at DESC",
    [id]
  );

  const { data: files } = useQuery<JobFileWithLocalUri>(
    `SELECT jf.id, a.local_uri
       FROM job_files jf
       LEFT JOIN attachments a ON a.id = jf.id
      WHERE jf.job_card_id = ?
      ORDER BY jf.created_at DESC`,
    [id]
  );

  // Quotes/invoices are online-only (see docs/SETUP.md), so unlike the rest
  // of this screen they're fetched straight from Supabase rather than a
  // PowerSync-watched local query, same as the quotes/invoices list screens.
  const { data: linkedQuotes } = useSupabaseFetch<Quote[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("quotes").select("*").eq("job_card_id", id);
    if (error) throw error;
    return (data ?? []) as Quote[];
  }, [id, isOnline]);

  const { data: linkedInvoices } = useSupabaseFetch<Invoice[]>(async () => {
    if (!isOnline) return [];
    const { data, error } = await supabase.from("invoices").select("*").eq("job_card_id", id);
    if (error) throw error;
    return (data ?? []) as Invoice[];
  }, [id, isOnline]);

  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);

  const handleStatusChange = async (status: JobStatus) => {
    await powersync.execute("UPDATE job_cards SET status = ? WHERE id = ?", [status, id]);
  };

  const handleAddTask = async () => {
    const result = createTaskSchema.safeParse({ title: taskTitle, job_card_id: id });
    if (!result.success) {
      setTaskError(result.error.issues[0]?.message ?? "Invalid task");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO tasks (id, tenant_id, job_card_id, title, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', ?, ?, ?)`,
      [uuidv4(), profile.tenant_id, id, result.data.title, profile.id, now, now]
    );
    setTaskTitle("");
    setTaskError(null);
  };

  const cycleTaskStatus = async (task: Task) => {
    await powersync.execute("UPDATE tasks SET status = ? WHERE id = ?", [NEXT_TASK_STATUS[task.status], task.id]);
  };

  const handleAddNote = async () => {
    const result = createJobNoteSchema.safeParse({ job_card_id: id, body: noteText });
    if (!result.success) {
      setNoteError(result.error.issues[0]?.message ?? "Note can't be empty");
      return;
    }
    if (!profile) return;

    await powersync.execute(
      "INSERT INTO job_notes (id, tenant_id, job_card_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), profile.tenant_id, id, profile.id, result.data.body, new Date().toISOString()]
    );
    setNoteText("");
    setNoteError(null);
  };

  const handleUploadPhoto = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile || !job) return;
    setUploading(true);
    try {
      await addJobPhoto({
        tenantId: profile.tenant_id,
        jobCardId: id,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(photo.base64),
        mediaType: photo.mimeType,
        fileExtension: photo.fileExtension,
      });
    } finally {
      setUploading(false);
    }
  };

  if (!job) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.section}>
        <Text style={styles.number}>{job.number ?? "Pending sync"}</Text>
        <Text style={styles.title}>{job.title}</Text>
        {job.description ? <Text style={styles.description}>{job.description}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Status</Text>
        <View style={styles.statusRow}>
          {STATUSES.map((status) => (
            <Pressable
              key={status}
              style={[styles.statusChip, job.status === status && styles.statusChipActive]}
              onPress={() => handleStatusChange(status)}
            >
              <Text style={[styles.statusChipText, job.status === status && styles.statusChipTextActive]}>
                {STATUS_LABELS[status]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quotes</Text>
        {(linkedQuotes ?? []).map((q) => (
          <Pressable key={q.id} style={styles.linkedRow} onPress={() => router.push(`/quotes/${q.id}`)}>
            <Text style={styles.linkedRowText}>{q.quote_number}</Text>
          </Pressable>
        ))}
        {isOnline && linkedQuotes?.length === 0 ? <Text style={styles.empty}>No quotes linked to this job.</Text> : null}
        {isOnline ? (
          <Pressable
            style={styles.linkButton}
            onPress={() => router.push({ pathname: "/quotes/new", params: { jobCardId: job.id, clientId: job.client_id } })}
          >
            <Text style={styles.linkButtonText}>+ New quote for this job</Text>
          </Pressable>
        ) : (
          <Text style={styles.empty}>Connect to view or create quotes.</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Invoices</Text>
        {(linkedInvoices ?? []).map((inv) => (
          <Pressable key={inv.id} style={styles.linkedRow} onPress={() => router.push(`/invoices/${inv.id}`)}>
            <Text style={styles.linkedRowText}>{inv.invoice_number}</Text>
          </Pressable>
        ))}
        {isOnline && linkedInvoices?.length === 0 ? <Text style={styles.empty}>No invoices linked to this job.</Text> : null}
        {isOnline ? (
          <Pressable
            style={styles.linkButton}
            onPress={() => router.push({ pathname: "/invoices/new", params: { jobCardId: job.id, clientId: job.client_id } })}
          >
            <Text style={styles.linkButtonText}>+ New invoice for this job</Text>
          </Pressable>
        ) : (
          <Text style={styles.empty}>Connect to view or create invoices.</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Tasks</Text>
        {jobTasks.map((t) => (
          <Pressable key={t.id} style={styles.taskRow} onPress={() => router.push(`/tasks/${t.id}`)}>
            <Text style={styles.taskRowTitle}>{t.title}</Text>
            <Pressable
              style={styles.taskStatusBadge}
              onPress={(e) => {
                e.stopPropagation();
                cycleTaskStatus(t);
              }}
            >
              <Text style={styles.taskStatusBadgeText}>{TASK_STATUS_LABELS[t.status]}</Text>
            </Pressable>
          </Pressable>
        ))}
        {jobTasks.length === 0 ? <Text style={styles.empty}>No tasks linked to this job.</Text> : null}
        {profile?.role === "admin" ? (
          <View style={styles.addTaskRow}>
            <View style={{ flex: 1 }}>
              <FormField label="Add a task" placeholder="Task title" value={taskTitle} onChangeText={setTaskTitle} />
            </View>
            <Pressable style={styles.button} onPress={handleAddTask}>
              <Text style={styles.buttonText}>Add</Text>
            </Pressable>
          </View>
        ) : null}
        {taskError ? <Text style={styles.error}>{taskError}</Text> : null}
      </View>

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  section: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb" },
  number: { fontSize: 12, fontWeight: "700", color: "#1d4ed8", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: "700" },
  description: { marginTop: 6, color: "#374151" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginBottom: 10 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600" },
  statusChipTextActive: { color: "#fff" },
  linkedRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0" },
  linkedRowText: { color: "#1d4ed8", fontWeight: "600" },
  linkButton: { marginTop: 10, alignSelf: "flex-start" },
  linkButtonText: { color: "#1d4ed8", fontWeight: "600" },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#f0f0f0",
  },
  taskRowTitle: { fontSize: 15, color: "#111827", flex: 1, marginRight: 8 },
  taskStatusBadge: { backgroundColor: "#f3f4f6", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  taskStatusBadgeText: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  addTaskRow: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "flex-end" },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  addNoteButton: { alignSelf: "flex-start", marginTop: 10 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 6 },
  noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0f0f0" },
  noteBody: { fontSize: 15, color: "#111827" },
  noteMeta: { fontSize: 12, color: "#9ca3af", marginTop: 4 },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
});
