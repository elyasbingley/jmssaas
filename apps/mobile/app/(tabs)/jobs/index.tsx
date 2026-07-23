import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createJobCardSchema, type Client, type JobCard, type JobStatus } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { CenteredModal } from "../../../components/CenteredModal";
import { FormField } from "../../../components/FormField";
import { PickerModal } from "../../../components/PickerModal";

const STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  invoiced: "Invoiced",
};

// Top-level Jobs list - previously job cards were only reachable by drilling
// into a client first. This is the new home for "Jobs" as its own section
// (see the home screen / tab bar restructure), with client scoped from here
// via a picker instead.
export default function JobsScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const { data: jobCards } = useQuery<JobCard>(
    isAdmin
      ? "SELECT * FROM job_cards ORDER BY created_at DESC"
      : "SELECT * FROM job_cards WHERE assigned_technician_id = ? ORDER BY created_at DESC",
    isAdmin ? [] : [profile?.id ?? ""]
  );
  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const [modalVisible, setModalVisible] = useState(false);
  const [clientPickerVisible, setClientPickerVisible] = useState(false);
  const [client, setClient] = useState<Client | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const clientNameById = new Map(clients.map((c) => [c.id, c.name]));

  const resetForm = () => {
    setClient(null);
    setTitle("");
    setDescription("");
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createJobCardSchema.safeParse({ client_id: client?.id, title, description });
    if (!result.success) {
      setFormError(client ? (result.error.issues[0]?.message ?? "Invalid job") : "Pick a client first");
      return;
    }
    if (!profile) return;

    const jobId = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO job_cards (id, tenant_id, client_id, title, description, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      [jobId, profile.tenant_id, result.data.client_id, result.data.title, result.data.description || null, profile.id, now, now]
    );

    resetForm();
    setModalVisible(false);
    router.push(`/jobs/${jobId}`);
  };

  return (
    <View style={styles.container}>
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
              <Text style={styles.rowSubtitle}>{clientNameById.get(item.client_id) ?? "Unknown client"}</Text>
            </View>
            <Text style={styles.statusBadge}>{STATUS_LABELS[item.status]}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No jobs yet.</Text>}
        contentContainerStyle={jobCards.length === 0 ? styles.emptyContainer : undefined}
      />

      {isAdmin ? (
        <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
          <Text style={styles.fabText}>+ New job</Text>
        </Pressable>
      ) : null}

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          resetForm();
        }}
      >
        <Text style={styles.modalTitle}>New job</Text>

        <Pressable style={styles.pickerField} onPress={() => setClientPickerVisible(true)}>
          <Text style={styles.pickerFieldLabel}>Client</Text>
          <Text style={client ? styles.pickerFieldText : styles.pickerFieldPlaceholder}>
            {client?.name ?? "Select a client"}
          </Text>
        </Pressable>

        {client ? (
          <View style={styles.clientSummary}>
            {client.phone ? <Text style={styles.clientSummarySub}>{client.phone}</Text> : null}
            {client.email ? <Text style={styles.clientSummarySub}>{client.email}</Text> : null}
            {client.address_line1 ? (
              <Text style={styles.clientSummarySub}>
                {[client.address_line1, client.suburb, client.state, client.postcode].filter(Boolean).join(", ")}
              </Text>
            ) : null}
          </View>
        ) : null}

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
        visible={clientPickerVisible}
        title="Select client"
        items={clients}
        getKey={(c) => c.id}
        getLabel={(c) => c.name}
        onSelect={setClient}
        onClose={() => setClientPickerVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
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
  pickerField: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, gap: 4 },
  pickerFieldLabel: { fontSize: 13, fontWeight: "600", color: "#374151" },
  pickerFieldText: { fontSize: 16, color: "#111827" },
  pickerFieldPlaceholder: { fontSize: 16, color: "#9ca3af" },
  clientSummary: { backgroundColor: "#f3f4f6", borderRadius: 8, padding: 10, gap: 2 },
  clientSummarySub: { fontSize: 13, color: "#6b7280" },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
