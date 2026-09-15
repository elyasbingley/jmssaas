import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface PanelProps {
  title: string;
  status?: string;
  right?: ReactNode;
  children: ReactNode;
}

// The bordered "HUD instrument cluster" card every Job Card section sits
// in - a 1px accent-coloured hairline border, a small header bar with an
// uppercase label + status dot, and a subtle outer glow via elevation-free
// boxShadow (RN's shadow* props don't render a glow on Android, so this
// uses boxShadow directly - supported on Android 13+/New Architecture and a
// no-op elsewhere, which is an acceptable "nice to have" degrade).
export function Panel({ title, status, right, children }: PanelProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.statusDot} />
          <Text style={styles.headerTitle}>{title}</Text>
        </View>
        {status ? <Text style={styles.headerStatus}>{status}</Text> : null}
        {right}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    panel: {
      borderWidth: 1,
      borderColor: tokens.border,
      backgroundColor: tokens.surface,
      borderRadius: 4,
      marginHorizontal: 12,
      marginTop: 12,
      overflow: "hidden" as const,
      boxShadow: `0 0 12px ${tokens.accentGlow}`,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      backgroundColor: tokens.background,
    },
    headerLeft: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    statusDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: tokens.accent,
      boxShadow: `0 0 6px ${tokens.accentGlow}`,
    },
    headerTitle: {
      color: tokens.accent,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      letterSpacing: 1.5,
      textTransform: "uppercase" as const,
    },
    headerStatus: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label - 1,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
    },
    body: {
      padding: 12,
      gap: 10,
    },
  };
}
