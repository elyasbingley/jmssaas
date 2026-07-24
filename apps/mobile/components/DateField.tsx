import { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker, { type DateTimePickerChangeEvent } from "@react-native-community/datetimepicker";

interface DateFieldProps {
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

// Tappable date/time picker replacing plain "YYYY-MM-DD" text fields across
// the app. Android has no combined "datetime" native picker (only "date" and
// "time" separately), so mode="datetime" is implemented as two sequential
// native dialogs there; iOS's inline picker supports date+time in one
// control, shown in a small centered popup with a Done button since
// "inline" style has no built-in dismiss action.
export function DateField({ label, value, onChange, mode = "date", placeholder = "Select..." }: DateFieldProps) {
  const [visible, setVisible] = useState(false);
  const [androidStep, setAndroidStep] = useState<"date" | "time">("date");

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

  // onChange (with its event.type === "set" | "dismissed" | "neutralButtonPressed"
  // discriminant) is deprecated in @react-native-community/datetimepicker@9 in
  // favour of three separate handlers: onValueChange only fires for an actual
  // selection (its `date` is always defined, unlike onChange's optional one),
  // onDismiss fires when the picker is closed without a selection, and
  // onNeutralButtonPress (Android-only "Clear" button) isn't used here.
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
              <DateTimePicker
                value={value ?? new Date()}
                mode={mode}
                display="inline"
                onValueChange={handleIosValueChange}
              />
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

const styles = StyleSheet.create({
  container: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600", color: "#374151" },
  field: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12 },
  valueText: { fontSize: 16, color: "#111827" },
  placeholderText: { fontSize: 16, color: "#9ca3af" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", alignItems: "center", justifyContent: "center" },
  iosCard: { backgroundColor: "#fff", borderRadius: 16, padding: 16, gap: 12 },
  doneButton: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 20 },
  doneButtonText: { color: "#1d4ed8", fontWeight: "700", fontSize: 16 },
});
