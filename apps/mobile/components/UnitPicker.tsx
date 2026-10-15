import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { LINE_ITEM_UNITS } from "@jmssaas/shared";
import { CenteredModal } from "./CenteredModal";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";

// Shared by LineItemEditor.tsx and the price-book item screens - curated
// dropdown (as a modal picker, RN has no inline <select>) plus a free-text
// field for anything not on the list.
const CURATED_UNITS = LINE_ITEM_UNITS.filter((u) => u !== "other");

export function UnitPicker({ value, onChangeValue }: { value: string | null | undefined; onChangeValue: (unit: string | null) => void }) {
  const styles = useThemedStyles(createStyles);
  const [open, setOpen] = useState(false);
  const [customText, setCustomText] = useState(() => (value && !(CURATED_UNITS as readonly string[]).includes(value) ? value : ""));

  return (
    <View>
      <Pressable style={styles.input} onPress={() => setOpen(true)}>
        <Text style={value ? styles.pickerValueText : styles.pickerPlaceholderText}>{value || "No unit"}</Text>
      </Pressable>
      <CenteredModal visible={open} onClose={() => setOpen(false)}>
        <Text style={styles.modalTitle}>Select a unit</Text>
        <Pressable
          style={styles.variationRow}
          onPress={() => {
            onChangeValue(null);
            setOpen(false);
          }}
        >
          <Text style={styles.variationRowText}>No unit</Text>
        </Pressable>
        {CURATED_UNITS.map((u) => (
          <Pressable
            key={u}
            style={styles.variationRow}
            onPress={() => {
              onChangeValue(u);
              setOpen(false);
            }}
          >
            <Text style={styles.variationRowText}>{u}</Text>
          </Pressable>
        ))}
        <Text style={styles.fieldLabel}>Other (type your own)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. roll, sheet"
          placeholderTextColor={styles.placeholder.color}
          value={customText}
          onChangeText={setCustomText}
        />
        <Pressable
          style={styles.modalCancel}
          onPress={() => {
            onChangeValue(customText.trim() || null);
            setOpen(false);
          }}
        >
          <Text style={styles.modalCancelText}>Use custom unit</Text>
        </Pressable>
      </CenteredModal>
    </View>
  );
}

function createStyles({ tokens, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    input: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 8,
      padding: 10,
      fontSize: 15,
      color: tokens.textPrimary,
      backgroundColor: tokens.background,
      ...mono,
    },
    placeholder: { color: tokens.textMuted },
    pickerValueText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    pickerPlaceholderText: { fontSize: 15, color: tokens.textMuted, ...mono },
    fieldLabel: { fontSize: 12, fontWeight: "600" as const, color: tokens.textMuted, ...mono },
    modalTitle: { fontSize: 18, fontWeight: "700" as const, color: tokens.accent, letterSpacing: 1.5, textTransform: "uppercase" as const, ...mono },
    variationRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    variationRowText: { fontSize: 15, color: tokens.textPrimary, ...mono },
    modalCancel: { marginTop: 8, alignSelf: "flex-end" as const },
    modalCancelText: { color: tokens.accent, fontWeight: "600" as const, ...mono },
  };
}
