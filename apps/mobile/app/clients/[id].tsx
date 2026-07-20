import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createJobCardSchema, type Client, type JobCard, type JobStatus } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";

const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

export default function ClientDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();

  const { data: clientRows } = useQuery<Client>("SELECT * FROM clients WHERE id = ?", [id]);
  const client = clientRows[0];
  const { data: jobCards } = useQuery<JobCard>(
    "SELECT * FROM job_cards WHERE client_id = ? ORDER BY created_at DESC",
    [id]
  );

  const [modalVisible, setModalVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async () => {
    const result = createJobCardSchema.safeParse({ client_id: id, title, description });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid job card");
      return;
    }
    if (!profile) return;

    const jobId = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO job_cards (id, tenant_id, client_id, title, description, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      [jobId, profile.tenant_id, id, result.data.title, result.data.description || null, profile.id, now, now]
    );

    setTitle("");
    setDescription("");
    setFormError(null);
    setModalVisible(false);
    router.push(`/jobs/${jobId}`);
  };

  if (!client) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.clientHeader}>
        <Text style={styles.clientName}>{client.name}</Text>
        {client.phone ? <Text style={styles.clientMeta}>{client.phone}</Text> : null}
        {client.email ? <Text style={styles.clientMeta}>{client.email}</Text> : null}
        {client.notes ? <Text style={styles.clientNotes}>{client.notes}</Text> : null}
      </View>

      <Text style={styles.sectionTitle}>Job cards</Text>
      <FlatList
        data={jobCards}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/jobs/${item.id}`)}>
            <Text style={styles.rowTitle}>{item.title}</Text>
            <Text style={styles.rowSubtitle}>{STATUS_LABELS[item.status]}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No job cards yet for this client.</Text>}
        contentContainerStyle={jobCards.length === 0 ? styles.emptyContainer : undefined}
      />

      <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+ New job card</Text>
      </Pressable>

      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New job card</Text>
            <TextInput style={styles.input} placeholder="Title" value={title} onChangeText={setTitle} />
            <TextInput
              style={[styles.input, styles.multiline]}
              placeholder="Description (e.g. valley channel inspection, supply and install)"
              value={description}
              onChangeText={setDescription}
              multiline
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
  clientHeader: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb", gap: 4 },
  clientName: { fontSize: 20, fontWeight: "700" },
  clientMeta: { color: "#6b7280" },
  clientNotes: { marginTop: 8, color: "#374151" },
  sectionTitle: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, fontWeight: "700", color: "#6b7280" },
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0" },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { color: "#6b7280", marginTop: 2 },
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
  multiline: { minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
