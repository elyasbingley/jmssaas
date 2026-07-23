import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

interface FormFieldProps extends TextInputProps {
  label: string;
}

// Thin wrapper adding a visible label above every text input in the app -
// before this, inputs only had placeholder text, which disappears the
// moment you start typing and left every box unlabeled.
export function FormField({ label, style, ...inputProps }: FormFieldProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={[styles.input, style]} placeholderTextColor="#9ca3af" {...inputProps} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600", color: "#374151" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 16, color: "#111827" },
});
