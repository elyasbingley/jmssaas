import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createClientSchema, createJobCardSchema, type Client, type JobCard, type JobStatus } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { formatClientAddress } from "../../../../lib/format";
import { CenteredModal } from "../../../../components/CenteredModal";
import { CommunicationLog } from "../../../../components/CommunicationLog";
import { FormField } from "../../../../components/FormField";

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
    router.push(`/sales/jobs/${jobId}`);
  };

  // --- Edit client ---
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editAddressLine1, setEditAddressLine1] = useState("");
  const [editAddressLine2, setEditAddressLine2] = useState("");
  const [editSuburb, setEditSuburb] = useState("");
  const [editState, setEditState] = useState("");
  const [editPostcode, setEditPostcode] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = () => {
    if (!client) return;
    setEditName(client.name);
    setEditPhone(client.phone ?? "");
    setEditEmail(client.email ?? "");
    setEditAddressLine1(client.address_line1 ?? "");
    setEditAddressLine2(client.address_line2 ?? "");
    setEditSuburb(client.suburb ?? "");
    setEditState(client.state ?? "");
    setEditPostcode(client.postcode ?? "");
    setEditNotes(client.notes ?? "");
    setEditError(null);
    setEditModalVisible(true);
  };

  const handleSaveEdit = async () => {
    const result = createClientSchema.safeParse({
      name: editName,
      phone: editPhone,
      email: editEmail,
      address_line1: editAddressLine1,
      address_line2: editAddressLine2,
      suburb: editSuburb,
      state: editState,
      postcode: editPostcode,
      notes: editNotes,
    });
    if (!result.success) {
      setEditError(result.error.issues[0]?.message ?? "Invalid client");
      return;
    }

    await powersync.execute(
      `UPDATE clients
          SET name = ?, phone = ?, email = ?, address_line1 = ?, address_line2 = ?,
              suburb = ?, state = ?, postcode = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      [
        result.data.name,
        result.data.phone || null,
        result.data.email || null,
        result.data.address_line1 || null,
        result.data.address_line2 || null,
        result.data.suburb || null,
        result.data.state || null,
        result.data.postcode || null,
        result.data.notes || null,
        new Date().toISOString(),
        id,
      ]
    );

    setEditModalVisible(false);
  };

  if (!client) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  const address = formatClientAddress(client);

  return (
    <View style={styles.container}>
      <View style={styles.clientHeader}>
        <View style={styles.clientHeaderRow}>
          <Text style={styles.clientName}>{client.name}</Text>
          <Pressable onPress={openEditModal}>
            <Text style={styles.link}>Edit</Text>
          </Pressable>
        </View>
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
          <Pressable style={styles.row} onPress={() => router.push(`/sales/jobs/${item.id}`)}>
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
        ListFooterComponent={
          // Scoped to this client's own jobs (On The Way/review-request
          // messages) - quote/invoice follow-ups aren't included here since
          // there's no locally-synced way to look up "which quotes/invoices
          // belong to this client" offline (quotes/invoices are online-only,
          // see docs/SETUP.md); the job detail screen shows those, since it
          // already fetches its own linked quotes/invoices from Supabase.
          <View style={styles.commLogSection}>
            <Text style={styles.sectionTitle}>Communication Log</Text>
            <CommunicationLog entities={jobCards.map((j) => ({ entityType: "job" as const, entityId: j.id }))} />
          </View>
        }
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

      <CenteredModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit client</Text>
        <FormField label="Name" placeholder="Client name" value={editName} onChangeText={setEditName} />
        <FormField label="Phone" placeholder="Phone number" value={editPhone} onChangeText={setEditPhone} keyboardType="phone-pad" />
        <FormField
          label="Email"
          placeholder="client@example.com"
          value={editEmail}
          onChangeText={setEditEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <FormField label="Address line 1" placeholder="Street address" value={editAddressLine1} onChangeText={setEditAddressLine1} />
        <FormField label="Address line 2 (optional)" placeholder="Unit, floor, etc." value={editAddressLine2} onChangeText={setEditAddressLine2} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItem}>
            <FormField label="Suburb" placeholder="Suburb" value={editSuburb} onChangeText={setEditSuburb} />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="State" placeholder="e.g. NSW" value={editState} onChangeText={setEditState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="Postcode" placeholder="e.g. 2000" value={editPostcode} onChangeText={setEditPostcode} keyboardType="number-pad" />
          </View>
        </View>
        <FormField
          label="Notes (optional)"
          placeholder="Notes"
          value={editNotes}
          onChangeText={setEditNotes}
          multiline
          style={styles.multiline}
        />
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  clientHeader: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#e5e7eb", gap: 4 },
  clientHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clientName: { fontSize: 20, fontWeight: "700" },
  clientMeta: { color: "#6b7280" },
  clientNotes: { marginTop: 8, color: "#374151" },
  sectionTitle: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, fontWeight: "700", color: "#6b7280" },
  commLogSection: { paddingHorizontal: 16, paddingBottom: 24 },
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
  addressRow: { flexDirection: "row", gap: 8 },
  addressRowItem: { flex: 2 },
  addressRowItemSmall: { flex: 1 },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
