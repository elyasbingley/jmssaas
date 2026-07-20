import { useState } from "react";
import { Alert, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createJobNoteSchema, type JobCard, type JobNote, type JobStatus } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { addJobPhoto } from "../../lib/powersync";

const STATUSES: JobStatus[] = ["new", "scheduled", "in_progress", "completed", "invoiced"];
const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

interface JobFileWithLocalUri {
  id: string;
  file_name: string;
  local_uri: string | null;
}

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const powersync = usePowerSync();
  const { profile } = useAuth();

  const { data: jobRows } = useQuery<JobCard>("SELECT * FROM job_cards WHERE id = ?", [id]);
  const job = jobRows[0];

  const { data: notes } = useQuery<JobNote>(
    "SELECT * FROM job_notes WHERE job_card_id = ? ORDER BY created_at DESC",
    [id]
  );

  const { data: files } = useQuery<JobFileWithLocalUri>(
    `SELECT jf.id, jf.file_name, a.local_uri
       FROM job_files jf
       LEFT JOIN attachments a ON a.id = jf.id
      WHERE jf.job_card_id = ?
      ORDER BY jf.created_at DESC`,
    [id]
  );

  const [noteText, setNoteText] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleStatusChange = async (status: JobStatus) => {
    await powersync.execute("UPDATE job_cards SET status = ? WHERE id = ?", [status, id]);
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

  const pickAndUpload = async (source: "camera" | "library") => {
    if (!profile || !job) return;

    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Enable photo access in Settings to attach photos to job cards.");
      return;
    }

    const pickerOptions: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], base64: true, quality: 0.6 };
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(pickerOptions)
        : await ImagePicker.launchImageLibraryAsync(pickerOptions);

    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;

    setUploading(true);
    try {
      await addJobPhoto({
        tenantId: profile.tenant_id,
        jobCardId: id,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(asset.base64),
        mediaType: asset.mimeType ?? "image/jpeg",
        fileExtension: asset.mimeType?.includes("png") ? "png" : "jpg",
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
        <Text style={styles.sectionTitle}>Photos {uploading ? "(uploading...)" : ""}</Text>
        <FlatList
          horizontal
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) =>
            item.local_uri ? (
              <Image source={{ uri: item.local_uri }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoPending]}>
                <Text style={styles.photoPendingText}>Syncing...</Text>
              </View>
            )
          }
          ListEmptyComponent={<Text style={styles.empty}>No photos yet.</Text>}
        />
        <View style={styles.photoActions}>
          <Pressable style={styles.button} onPress={() => pickAndUpload("camera")}>
            <Text style={styles.buttonText}>Take photo</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonSecondary]} onPress={() => pickAndUpload("library")}>
            <Text style={[styles.buttonText, styles.buttonSecondaryText]}>Choose photo</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          placeholder="Add a note..."
          value={noteText}
          onChangeText={setNoteText}
          multiline
        />
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
  title: { fontSize: 20, fontWeight: "700" },
  description: { marginTop: 6, color: "#374151" },
  sectionTitle: { fontWeight: "700", color: "#6b7280", marginBottom: 10 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600" },
  statusChipTextActive: { color: "#fff" },
  photo: { width: 96, height: 96, borderRadius: 8, marginRight: 8, backgroundColor: "#e5e7eb" },
  photoPending: { alignItems: "center", justifyContent: "center" },
  photoPendingText: { fontSize: 11, color: "#6b7280" },
  photoActions: { flexDirection: "row", gap: 12, marginTop: 12 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  buttonSecondary: { backgroundColor: "#f3f4f6" },
  buttonText: { color: "#fff", fontWeight: "600" },
  buttonSecondaryText: { color: "#1d4ed8" },
  addNoteButton: { alignSelf: "flex-start", marginTop: 10 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  multiline: { minHeight: 70, textAlignVertical: "top" },
  error: { color: "#dc2626", marginTop: 6 },
  noteRow: { marginTop: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#f0f0f0" },
  noteBody: { fontSize: 15, color: "#111827" },
  noteMeta: { fontSize: 12, color: "#9ca3af", marginTop: 4 },
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
});
