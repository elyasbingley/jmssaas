import { Text, View } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

// Theme-aware sibling of components/RequiresConnectionNotice.tsx - see
// ThemedModal.tsx for why this isn't just a retheme of the shared original.
export function ThemedRequiresConnectionNotice({ label }: { label: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>No Connection</Text>
      <Text style={styles.body}>
        {`This device is offline. ${label} are an office/PC workflow that needs a connection - reconnect to view or edit them.`}
      </Text>
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, padding: 24, gap: 8 },
    title: {
      fontSize: font.title,
      fontWeight: "700" as const,
      color: tokens.accent,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
      ...mono,
    },
    body: { textAlign: "center" as const, color: tokens.textMuted, fontSize: font.body - 1, ...mono },
  };
}
