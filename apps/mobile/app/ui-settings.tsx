import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { ACCENT_OPTIONS, FONT_FAMILY_OPTIONS, FONT_SIZE_OPTIONS, type AccentId, type FontFamilyId, type FontSizeId } from "@jmssaas/shared";
import { useTheme } from "../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { Panel } from "../components/theme/Panel";
import { Readout } from "../components/theme/Readout";

export default function UISettingsScreen() {
  const router = useRouter();
  const { tokens, prefs, setAccent, setFontSize, setFontFamily } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.backLink}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.headerTitle}>UI Settings</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Panel title="Accent Colour" status={ACCENT_OPTIONS.find((a) => a.id === prefs.accent)?.label}>
          <View style={styles.swatchRow}>
            {ACCENT_OPTIONS.map((option) => (
              <AccentSwatch key={option.id} id={option.id} label={option.label} selected={option.id === prefs.accent} onPress={() => setAccent(option.id)} />
            ))}
          </View>
        </Panel>

        <Panel title="Font Size">
          <View style={styles.segmentedRow}>
            {FONT_SIZE_OPTIONS.map((option) => (
              <SegmentButton
                key={option.id}
                label={option.label}
                selected={option.id === prefs.fontSize}
                onPress={() => setFontSize(option.id)}
              />
            ))}
          </View>
        </Panel>

        <Panel title="Font Type">
          <View style={{ gap: 4 }}>
            {FONT_FAMILY_OPTIONS.map((option) => (
              <FontFamilyRow
                key={option.id}
                id={option.id}
                label={option.label}
                selected={option.id === prefs.fontFamily}
                onPress={() => setFontFamily(option.id)}
              />
            ))}
          </View>
        </Panel>

        <Panel title="Live Preview" status="ONLINE">
          <Readout label="Job Status" value="IN PROGRESS" />
          <Readout label="Technician" value="J. BINGLEY" />
          <Readout label="Priority" value="HIGH" danger />
        </Panel>

        <Text style={[styles.footnote, { color: tokens.textMuted }]}>
          Changes apply immediately across the app and are saved to this device.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function AccentSwatch({ id, label, selected, onPress }: { id: AccentId; label: string; selected: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createSwatchStyles);
  // Each swatch previews its OWN accent colour (not the currently active
  // one), so this is the only place that needs a colour outside the active
  // theme - resolved locally rather than threading a second theme instance
  // through context.
  const accentColor = ACCENT_HEX[id];
  return (
    <Pressable onPress={onPress} style={styles.swatchWrap}>
      <View style={[styles.swatch, { borderColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }, selected && { backgroundColor: `${accentColor}33` }]}>
        <View style={[styles.swatchDot, { backgroundColor: accentColor }]} />
      </View>
      <Text style={[styles.swatchLabel, selected && { color: accentColor }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

// Local hex lookup purely for rendering each option's own preview colour in
// the picker (see AccentSwatch above) - the app's actual active tokens
// always come from useTheme()/ACCENT_PRESETS via the shared theme module.
const ACCENT_HEX: Record<AccentId, string> = {
  green: "#39ff6a",
  cyan: "#39e6ff",
  magenta: "#ff3ec8",
  amber: "#ffb020",
  purple: "#a855f7",
  red: "#ff3b3b",
};

function SegmentButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createSegmentStyles);
  return (
    <Pressable onPress={onPress} style={[styles.segment, selected && styles.segmentSelected]}>
      <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function FontFamilyRow({ id, label, selected, onPress }: { id: FontFamilyId; label: string; selected: boolean; onPress: () => void }) {
  const option = FONT_FAMILY_OPTIONS.find((f) => f.id === id)!;
  const styles = useThemedStyles(createFontRowStyles);
  return (
    <Pressable onPress={onPress} style={[styles.row, selected && styles.rowSelected]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]}>{label}</Text>
        <Text style={[styles.sample, { fontFamily: option.mobileFontFamily }]}>THE QUICK BROWN FOX 0123456789</Text>
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
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
    backLink: {
      color: tokens.accent,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.body,
      letterSpacing: 1,
    },
    headerTitle: {
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.title,
      letterSpacing: 2,
      textTransform: "uppercase" as const,
    },
    swatchRow: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 14,
    },
    footnote: {
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      textAlign: "center" as const,
      marginTop: 16,
      marginHorizontal: 24,
    },
    segmentedRow: {
      flexDirection: "row" as const,
      gap: 8,
    },
  };
}

function createSwatchStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    swatchWrap: { alignItems: "center" as const, width: 78, gap: 6 },
    swatch: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 2,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: tokens.background,
    },
    swatchDot: { width: 16, height: 16, borderRadius: 8 },
    swatchLabel: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label - 1,
      textAlign: "center" as const,
      textTransform: "uppercase" as const,
    },
  };
}

function createSegmentStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    segment: {
      flex: 1,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      paddingVertical: 10,
      alignItems: "center" as const,
    },
    segmentSelected: {
      borderColor: tokens.accent,
      backgroundColor: tokens.accentGlow,
    },
    segmentText: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.body,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
    },
    segmentTextSelected: {
      color: tokens.accent,
    },
  };
}

function createFontRowStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 3,
      padding: 10,
      gap: 8,
    },
    rowSelected: {
      borderColor: tokens.accent,
    },
    rowLabel: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
      marginBottom: 3,
    },
    rowLabelSelected: {
      color: tokens.accent,
    },
    sample: {
      color: tokens.textPrimary,
      fontSize: font.body,
    },
    check: {
      color: tokens.accent,
      fontSize: font.title,
    },
  };
}
