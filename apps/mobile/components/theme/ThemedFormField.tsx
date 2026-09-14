import { Text, TextInput, View, type TextInputProps } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface ThemedFormFieldProps extends TextInputProps {
  label: string;
}

// Theme-aware sibling of components/FormField.tsx, used only from
// CRT-themed screens (currently the mobile Job Card's modals) - see
// ThemedModal.tsx for why this isn't just a retheme of the shared original.
export function ThemedFormField({ label, style, ...inputProps }: ThemedFormFieldProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={[styles.input, style]} placeholderTextColor={styles.placeholder.color} {...inputProps} />
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
    input: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 12,
      fontSize: font.body,
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      backgroundColor: tokens.background,
    },
    placeholder: { color: tokens.textMuted },
  };
}
