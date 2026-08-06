import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createClientSchema, type Client } from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { CenteredModal } from "../../../../components/CenteredModal";
import { FormField } from "../../../../components/FormField";

export default function ClientsScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const [modalVisible, setModalVisible] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [suburb, setSuburb] = useState("");
  const [state, setState] = useState("");
  const [postcode, setPostcode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setPhone("");
    setEmail("");
    setAddressLine1("");
    setAddressLine2("");
    setSuburb("");
    setState("");
    setPostcode("");
    setFormError(null);
  };

  const handleCreate = async () => {
    const result = createClientSchema.safeParse({
      name,
      phone,
      email,
      address_line1: addressLine1,
      address_line2: addressLine2,
      suburb,
      state,
      postcode,
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid client");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO clients
         (id, tenant_id, name, phone, email, address_line1, address_line2, suburb, state, postcode, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        profile.tenant_id,
        result.data.name,
        result.data.phone || null,
        result.data.email || null,
        result.data.address_line1 || null,
        result.data.address_line2 || null,
        result.data.suburb || null,
        result.data.state || null,
        result.data.postcode || null,
        profile.id,
        now,
        now,
      ]
    );

    resetForm();
    setModalVisible(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.subtitle}>{clients.length} client{clients.length === 1 ? "" : "s"}</Text>
      </View>

      <FlatList
        data={clients}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/sales/clients/${item.id}`)}>
            <Text style={styles.rowTitle}>{item.name}</Text>
            {item.phone ? <Text style={styles.rowSubtitle}>{item.phone}</Text> : null}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No clients yet. Add your first one below.</Text>}
        contentContainerStyle={clients.length === 0 ? styles.emptyContainer : undefined}
      />

      <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+ New client</Text>
      </Pressable>

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          resetForm();
        }}
      >
        <Text style={styles.modalTitle}>New client</Text>
        <FormField label="Name" placeholder="Client name" value={name} onChangeText={setName} />
        <FormField label="Phone" placeholder="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <FormField
          label="Email"
          placeholder="client@example.com"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <FormField label="Address line 1" placeholder="Street address" value={addressLine1} onChangeText={setAddressLine1} />
        <FormField label="Address line 2 (optional)" placeholder="Unit, floor, etc." value={addressLine2} onChangeText={setAddressLine2} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItem}>
            <FormField label="Suburb" placeholder="Suburb" value={suburb} onChangeText={setSuburb} />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="State" placeholder="e.g. NSW" value={state} onChangeText={setState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="Postcode" placeholder="e.g. 2000" value={postcode} onChangeText={setPostcode} keyboardType="number-pad" />
          </View>
        </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  subtitle: { color: "#6b7280" },
  link: { color: "#1d4ed8", fontWeight: "600" },
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#f0f0f0" },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowSubtitle: { color: "#6b7280", marginTop: 2 },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
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
  addressRow: { flexDirection: "row", gap: 8 },
  addressRowItem: { flex: 2 },
  addressRowItemSmall: { flex: 1 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
