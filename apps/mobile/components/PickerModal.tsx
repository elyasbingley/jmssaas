import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

interface PickerModalProps<T> {
  visible: boolean;
  title: string;
  items: T[];
  getLabel: (item: T) => string;
  getKey: (item: T) => string;
  onSelect: (item: T) => void;
  onClose: () => void;
}

// Generic searchable picker used anywhere a form needs to pick one row from
// a list fetched elsewhere (client, job card, template) - quotes/new,
// quotes/[id], invoices/new and invoices/[id] all use this instead of each
// rolling their own modal + filter logic. Centered + keyboard-avoiding
// (like CenteredModal) rather than bottom-anchored, so the keyboard opened
// by the search field can never cover it.
export function PickerModal<T>({ visible, title, items, getLabel, getKey, onSelect, onClose }: PickerModalProps<T>) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) => getLabel(item).toLowerCase().includes(query.toLowerCase()));

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.title}>{title}</Text>
            <TextInput style={styles.input} placeholder="Search..." value={query} onChangeText={setQuery} />
            <FlatList
              data={filtered}
              keyExtractor={getKey}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={styles.row}
                  onPress={() => {
                    onSelect(item);
                    setQuery("");
                    onClose();
                  }}
                >
                  <Text style={styles.rowText}>{getLabel(item)}</Text>
                </Pressable>
              )}
              ListEmptyComponent={<Text style={styles.empty}>No matches.</Text>}
            />
            <Pressable
              onPress={() => {
                setQuery("");
                onClose();
              }}
              style={styles.closeButton}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center", padding: 20 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, width: "100%", maxWidth: 480, maxHeight: "80%" },
  title: { fontSize: 18, fontWeight: "700", marginBottom: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16, marginBottom: 8 },
  list: { maxHeight: 320 },
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  rowText: { fontSize: 15 },
  empty: { textAlign: "center", color: "#6b7280", padding: 16 },
  closeButton: { marginTop: 12, alignSelf: "center" },
  closeText: { color: "#1d4ed8", fontWeight: "600" },
});
