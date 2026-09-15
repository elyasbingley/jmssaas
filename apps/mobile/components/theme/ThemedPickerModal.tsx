import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface ThemedPickerModalProps<T> {
  visible: boolean;
  title: string;
  items: T[];
  getLabel: (item: T) => string;
  getKey: (item: T) => string;
  onSelect: (item: T) => void;
  onClose: () => void;
}

// Theme-aware sibling of components/PickerModal.tsx - see ThemedModal.tsx
// for why this isn't just a retheme of the shared original.
export function ThemedPickerModal<T>({ visible, title, items, getLabel, getKey, onSelect, onClose }: ThemedPickerModalProps<T>) {
  const [query, setQuery] = useState("");
  const styles = useThemedStyles(createStyles);
  const filtered = items.filter((item) => getLabel(item).toLowerCase().includes(query.toLowerCase()));

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Pressable style={styles.overlay} onPress={onClose}>
          <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.title}>{title}</Text>
            <TextInput
              style={styles.input}
              placeholder="Search..."
              placeholderTextColor={styles.placeholder.color}
              value={query}
              onChangeText={setQuery}
            />
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

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    flex: { flex: 1 },
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center" as const, justifyContent: "center" as const, padding: 20 },
    card: {
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      padding: 20,
      width: "100%" as const,
      maxWidth: 480,
      maxHeight: "80%" as const,
      boxShadow: `0 0 16px ${tokens.accentGlow}`,
    },
    title: {
      fontSize: font.title,
      color: tokens.accent,
      fontFamily: fontFamily.mobileFontFamily,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      marginBottom: 12,
    },
    input: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 12,
      fontSize: font.body,
      marginBottom: 8,
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      backgroundColor: tokens.background,
    },
    placeholder: { color: tokens.textMuted },
    list: { maxHeight: 320 },
    row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: tokens.border },
    rowText: { fontSize: font.body, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 16, fontFamily: fontFamily.mobileFontFamily },
    closeButton: { marginTop: 12, alignSelf: "center" as const },
    closeText: { color: tokens.accent, fontWeight: "600" as const, fontFamily: fontFamily.mobileFontFamily },
  };
}
