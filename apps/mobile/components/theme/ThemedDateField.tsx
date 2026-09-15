import { useState } from "react";
import { Modal, Platform, Pressable, Text, View } from "react-native";
import DateTimePicker, { type DateTimePickerChangeEvent } from "@react-native-community/datetimepicker";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface ThemedDateFieldProps {
  label: string;
  value: Date | null;
  onChange: (date: Date) => void;
  mode?: "date" | "time" | "datetime";
  placeholder?: string;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

// Theme-aware sibling of components/DateField.tsx - identical native picker
// behaviour (see that file's own comment on the Android/iOS split), only the
// styling changes. See ThemedModal.tsx for why this isn't just a retheme of
// the shared original.
export function ThemedDateField({ label, value, onChange, mode = "date", placeholder = "Select..." }: ThemedDateFieldProps) {
  const [visible, setVisible] = useState(false);
  const [androidStep, setAndroidStep] = useState<"date" | "time">("date");
  const styles = useThemedStyles(createStyles);

  const open = () => {
    setAndroidStep("date");
    setVisible(true);
  };

  const displayText = value
    ? mode === "date"
      ? formatDate(value)
      : mode === "time"
        ? formatTime(value)
        : `${formatDate(value)}, ${formatTime(value)}`
    : placeholder;

  const handleAndroidValueChange = (_event: DateTimePickerChangeEvent, selected: Date) => {
    if (mode === "datetime" && androidStep === "date") {
      onChange(selected);
      setAndroidStep("time");
      return;
    }
    onChange(selected);
    setVisible(false);
  };

  const handleAndroidDismiss = () => {
    setVisible(false);
  };

  const handleIosValueChange = (_event: DateTimePickerChangeEvent, selected: Date) => {
    onChange(selected);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <Pressable style={styles.field} onPress={open}>
        <Text style={value ? styles.valueText : styles.placeholderText}>{displayText}</Text>
      </Pressable>

      {visible && Platform.OS === "android" ? (
        <DateTimePicker
          value={value ?? new Date()}
          mode={mode === "datetime" ? androidStep : mode}
          display="default"
          onValueChange={handleAndroidValueChange}
          onDismiss={handleAndroidDismiss}
        />
      ) : null}

      {Platform.OS === "ios" ? (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
          <Pressable style={styles.overlay} onPress={() => setVisible(false)}>
            <Pressable style={styles.iosCard} onPress={(e) => e.stopPropagation()}>
              <DateTimePicker value={value ?? new Date()} mode={mode} display="inline" onValueChange={handleIosValueChange} />
              <Pressable style={styles.doneButton} onPress={() => setVisible(false)}>
                <Text style={styles.doneButtonText}>Done</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    container: { gap: 6 },
    label: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
    },
    field: { borderWidth: 1, borderColor: tokens.border, borderRadius: 3, padding: 12, backgroundColor: tokens.background },
    valueText: { fontSize: font.body, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    placeholderText: { fontSize: font.body, color: tokens.textMuted, fontFamily: fontFamily.mobileFontFamily },
    overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center" as const, justifyContent: "center" as const },
    iosCard: {
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 6,
      padding: 16,
      gap: 12,
      boxShadow: `0 0 16px ${tokens.accentGlow}`,
    },
    doneButton: { alignSelf: "center" as const, paddingVertical: 8, paddingHorizontal: 20 },
    doneButtonText: { color: tokens.accent, fontWeight: "700" as const, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
  };
}
