import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createClientSchema, type Client } from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";

export default function ClientsScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile, signOut } = useAuth();
  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");

  const [modalVisible, setModalVisible] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async () => {
    const result = createClientSchema.safeParse({ name, phone });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid client");
      return;
    }
    if (!profile) return;

    const now = new Date().toISOString();
    await powersync.execute(
      "INSERT INTO clients (id, tenant_id, name, phone, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [uuidv4(), profile.tenant_id, result.data.name, result.data.phone || null, profile.id, now, now]
    );

    setName("");
    setPhone("");
    setFormError(null);
    setModalVisible(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.subtitle}>{clients.length} client{clients.length === 1 ? "" : "s"}</Text>
        <Pressable onPress={signOut}>
          <Text style={styles.link}>Sign out</Text>
        </Pressable>
      </View>

      <FlatList
        data={clients}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/clients/${item.id}`)}>
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

      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New client</Text>
            <TextInput style={styles.input} placeholder="Name" value={name} onChangeText={setName} />
            <TextInput
              style={styles.input}
              placeholder="Phone"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
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
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
});
