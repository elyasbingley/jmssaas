import { Text, View } from "react-native";
import type { TaskQuadrant } from "@jmssaas/shared";
import { quadrantLabel } from "../../lib/task-matrix";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface QuadrantBadgeProps {
  quadrant: TaskQuadrant;
  overdue?: boolean;
}

// This theme has a single accent colour per preset (see use-themed-styles.ts
// / ThemeTokens), not four distinct quadrant hues, so quadrants are told
// apart by label text rather than colour - inventing four ad hoc colours
// outside the token system would look inconsistent with the rest of the app
// and fight whatever accent the user has chosen. Unsorted reads as visually
// "unset" (muted border, no fill) rather than as a fifth quadrant colour.
export function QuadrantBadge({ quadrant, overdue }: QuadrantBadgeProps) {
  const styles = useThemedStyles(createStyles);
  const isUnsorted = quadrant === "unsorted";
  return (
    <View style={styles.row}>
      <View style={[styles.badge, isUnsorted && styles.badgeMuted]}>
        <Text style={[styles.text, isUnsorted && styles.textMuted]}>{quadrantLabel(quadrant).toUpperCase()}</Text>
      </View>
      {overdue ? <Text style={styles.overdue}>⚠ OVERDUE</Text> : null}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    badge: {
      alignSelf: "flex-start" as const,
      borderWidth: 1,
      borderColor: tokens.accent,
      backgroundColor: tokens.accentGlow,
      borderRadius: 3,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeMuted: { borderColor: tokens.border, backgroundColor: "transparent" },
    text: { color: tokens.accent, fontSize: font.label, fontWeight: "700" as const, letterSpacing: 1, ...mono },
    textMuted: { color: tokens.textMuted },
    overdue: { color: tokens.danger, fontSize: font.label, fontWeight: "700" as const, letterSpacing: 0.5, ...mono },
  };
}
