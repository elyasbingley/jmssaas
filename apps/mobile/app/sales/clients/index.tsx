import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import { createClientSchema, type Client } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";
import { ThemedModal } from "../../../components/theme/ThemedModal";
import { ThemedFormField } from "../../../components/theme/ThemedFormField";
import { ThemedButton } from "../../../components/theme/ThemedButton";

export default function ClientsScreen() {
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const { data: clients } = useQuery<Client>("SELECT * FROM clients ORDER BY name");
  const styles = useThemedStyles(createStyles);

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

  const closeModal = () => {
    setModalVisible(false);
    resetForm();
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
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Clients</Text>
          <Pressable style={styles.addButton} onPress={() => setModalVisible(true)} hitSlop={8}>
            <Text style={styles.addButtonText}>+</Text>
          </Pressable>
        </View>
        <Text style={styles.subtitle}>{clients.length} client{clients.length === 1 ? "" : "s"}</Text>

        <FlatList
          style={styles.list}
          data={clients}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => router.push(`/sales/clients/${item.id}`)}>
              <Text style={styles.rowTitle}>{item.name}</Text>
              {item.phone ? <Text style={styles.rowSubtitle}>{item.phone}</Text> : null}
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.empty}>No clients yet. Add your first one below.</Text>}
          contentContainerStyle={clients.length === 0 ? styles.emptyContainer : styles.listContent}
        />
      </SafeAreaView>

      <ThemedModal visible={modalVisible} onClose={closeModal}>
        <Text style={styles.modalTitle}>New Client</Text>
        <ThemedFormField label="Name" placeholder="Client name" value={name} onChangeText={setName} />
        <ThemedFormField label="Phone" placeholder="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <ThemedFormField
          label="Email"
          placeholder="client@example.com"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <ThemedFormField label="Address line 1" placeholder="Street address" value={addressLine1} onChangeText={setAddressLine1} />
        <ThemedFormField label="Address line 2 (optional)" placeholder="Unit, floor, etc." value={addressLine2} onChangeText={setAddressLine2} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItem}>
            <ThemedFormField label="Suburb" placeholder="Suburb" value={suburb} onChangeText={setSuburb} />
          </View>
          <View style={styles.addressRowItemSmall}>
            <ThemedFormField label="State" placeholder="e.g. NSW" value={state} onChangeText={setState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <ThemedFormField label="Postcode" placeholder="e.g. 2000" value={postcode} onChangeText={setPostcode} keyboardType="number-pad" />
          </View>
        </View>
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={closeModal}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <ThemedButton label="Save" onPress={handleCreate} />
        </View>
      </ThemedModal>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      gap: 6,
    },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, flex: 1, ...mono },
    addButton: {
      width: 36,
      height: 36,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: tokens.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: tokens.accentGlow,
    },
    addButtonText: { color: tokens.accent, fontSize: 22, fontWeight: "700" as const, marginTop: -2, ...mono },
    subtitle: { color: tokens.textMuted, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, fontSize: font.label, ...mono },
    list: { flex: 1 },
    listContent: { paddingBottom: 24 },
    row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: tokens.border },
    rowTitle: { fontSize: font.body, fontWeight: "600" as const, color: tokens.textPrimary, ...mono },
    rowSubtitle: { color: tokens.textMuted, marginTop: 2, fontSize: font.label, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, ...mono },
    emptyContainer: { flex: 1, justifyContent: "center" as const, padding: 24 },
    modalTitle: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      marginBottom: 4,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    addressRow: { flexDirection: "row" as const, gap: 8 },
    addressRowItem: { flex: 2 },
    addressRowItemSmall: { flex: 1 },
    modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 20, marginTop: 8 },
    error: { color: tokens.danger, ...mono },
  };
}
