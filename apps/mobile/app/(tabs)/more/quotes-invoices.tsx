import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemedStyles, type StyleTheme } from "../../../lib/use-themed-styles";

// Small chooser page - "Quotes & Invoices" on the More screen leads here,
// which just picks between the two existing (unchanged) sections rather
// than merging them into one screen.
export default function QuotesInvoicesScreen() {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Quotes & Invoices</Text>
        </View>

        <View style={styles.grid}>
          <Pressable style={styles.tile} onPress={() => router.push("/sales/quotes")}>
            <Text style={styles.tileEmoji}>📝</Text>
            <Text style={styles.tileLabel}>Quotes</Text>
          </Pressable>
          <Pressable style={styles.tile} onPress={() => router.push("/sales/invoices")}>
            <Text style={styles.tileEmoji}>🧾</Text>
            <Text style={styles.tileLabel}>Invoices</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    screen: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 6 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    headerTitle: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, padding: 12, gap: 12 },
    tile: {
      width: "46%" as const,
      aspectRatio: 1.3,
      backgroundColor: tokens.surface,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    tileEmoji: { fontSize: 32 },
    tileLabel: {
      fontSize: font.body,
      fontWeight: "700" as const,
      color: tokens.textPrimary,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      ...mono,
    },
  };
}
