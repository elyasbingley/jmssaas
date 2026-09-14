import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { useThemedStyles, type StyleTheme } from "../../../../lib/use-themed-styles";

interface ToolEntry {
  label: string;
  available: boolean;
}

// Only Roof Area is a real, built tool right now (apps/mobile/app/(tabs)/
// sales/jobs/measure.tsx). The other five are listed per the Job Tools
// spec so the menu's shape is right, but are NOT built - see this
// session's summary for why (no spec for their formulas/UI exists
// anywhere in this codebase's history) rather than guessing at them.
const TOOLS: ToolEntry[] = [
  { label: "Roof Area", available: true },
  { label: "Linear Measurer", available: false },
  { label: "Material Tally", available: false },
  { label: "Photo Markup", available: false },
  { label: "Concrete Calculator", available: false },
  { label: "Material Order", available: false },
];

export default function JobToolsScreen() {
  const { jobCardId } = useLocalSearchParams<{ jobCardId: string }>();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backLink}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Job Tools</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.list}>
          {TOOLS.map((tool) => (
            <Pressable
              key={tool.label}
              style={styles.row}
              onPress={() => {
                if (tool.label === "Roof Area") {
                  router.push({ pathname: "/sales/jobs/measure", params: { jobCardId } });
                  return;
                }
                Alert.alert("Coming soon", `${tool.label} isn't built yet.`);
              }}
            >
              <Text style={tool.available ? styles.rowLabel : styles.rowLabelDisabled}>{tool.label}</Text>
              <Text style={tool.available ? styles.statusAvailable : styles.statusComingSoon}>
                {tool.available ? "AVAILABLE" : "COMING SOON"}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    backLink: { color: tokens.accent, fontFamily: fontFamily.mobileFontFamily, fontSize: font.body, letterSpacing: 1 },
    headerTitle: {
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.title,
      letterSpacing: 2,
      textTransform: "uppercase" as const,
    },
    list: { padding: 12 },
    row: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 4,
      padding: 14,
      marginBottom: 10,
      backgroundColor: tokens.surface,
    },
    rowLabel: { color: tokens.textPrimary, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
    rowLabelDisabled: { color: tokens.textMuted, fontSize: font.body, fontFamily: fontFamily.mobileFontFamily },
    statusAvailable: {
      color: tokens.accent,
      fontSize: font.label - 1,
      letterSpacing: 1,
      fontFamily: fontFamily.mobileFontFamily,
    },
    statusComingSoon: {
      color: tokens.textMuted,
      fontSize: font.label - 1,
      letterSpacing: 1,
      fontFamily: fontFamily.mobileFontFamily,
    },
  };
}
