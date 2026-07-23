import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createJobCardSchema, type Client, type JobCard, type JobStatus } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { CenteredModal } from "../../../components/CenteredModal";
import { FormField } from "../../../components/FormField";

const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

function formatAddress(client: Client): string | null {
  const parts = [client.address_line1, client.address_line2, [client.suburb, client.state, client.postcode].filter(Boolean).join(" ")]
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

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
      setFormError(result.error.issues[0]?.message ?? "Invalid job");
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

  const address = formatAddress(client);

  return (
    <View style={styles.container}>
      <View style={styles.clientHeader}>
        <Text style={styles.clientName}>{client.name}</Text>
        {client.phone ? <Text style={styles.clientMeta}>{client.phone}</Text> : null}
        {client.email ? <Text style={styles.clientMeta}>{client.email}</Text> : null}
        {address ? <Text style={styles.clientMeta}>{address}</Text> : null}
        {client.notes ? <Text style={styles.clientNotes}>{client.notes}</Text> : null}
      </View>

      <Text style={styles.sectionTitle}>Jobs</Text>
      <FlatList
        data={jobCards}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/jobs/${item.id}`)}>
            <View style={{ flex: 1 }}>
              <View style={styles.rowTitleRow}>
                <Text style={styles.rowNumber}>{item.number ?? "Pending sync"}</Text>
                <Text style={styles.rowTitle}>{item.title}</Text>
              </View>
            </View>
            <Text style={styles.rowSubtitle}>{STATUS_LABELS[item.status]}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No jobs yet for this client.</Text>}
        contentContainerStyle={jobCards.length === 0 ? styles.emptyContainer : undefined}
      />

      <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+ New job</Text>
      </Pressable>

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          setFormError(null);
        }}
      >
        <Text style={styles.modalTitle}>New job</Text>
        {/* Client details are auto-populated by the job_cards.client_id
            link (this same row shown above) rather than re-entered here -
            there's no separate copy of name/address/email/phone to keep in
            sync, so there's nothing that could drift out of date. */}
        <View style={styles.clientSummary}>
          <Text style={styles.clientSummaryLabel}>Client</Text>
          <Text style={styles.clientSummaryText}>{client.name}</Text>
          {client.phone ? <Text style={styles.clientSummarySub}>{client.phone}</Text> : null}
          {client.email ? <Text style={styles.clientSummarySub}>{client.email}</Text> : null}
          {address ? <Text style={styles.clientSummarySub}>{address}</Text> : null}
        </View>
        <FormField label="Title" placeholder="e.g. Roof inspection" value={title} onChangeText={setTitle} />
        <FormField
          label="Description (optional)"
          placeholder="e.g. valley channel inspection, supply and install"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.multiline}
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
      </CenteredModal>
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
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0", flexDirection: "row", alignItems: "center" },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowNumber: { fontSize: 12, fontWeight: "700", color: "#1d4ed8" },
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
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  clientSummary: { backgroundColor: "#f3f4f6", borderRadius: 8, padding: 12, gap: 2 },
  clientSummaryLabel: { fontSize: 12, fontWeight: "700", color: "#6b7280", marginBottom: 2 },
  clientSummaryText: { fontSize: 15, fontWeight: "600", color: "#111827" },
  clientSummarySub: { fontSize: 13, color: "#6b7280" },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
