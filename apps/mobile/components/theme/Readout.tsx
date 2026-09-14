import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface ReadoutProps {
  label: string;
  value: ReactNode;
  onPress?: () => void;
  danger?: boolean;
}

// Tight uppercase-label : accent-value pair used throughout the HUD
// reference screenshots (client name, address, phone, category, stage...).
// Tappable when `onPress` is given (address -> Maps, phone -> dialer).
export function Readout({ label, value, onPress, danger }: ReadoutProps) {
  const styles = useThemedStyles(createStyles);
  const content = (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, danger && styles.valueDanger]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    row: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      gap: 12,
    },
    pressed: {
      opacity: 0.6,
    },
    label: {
      color: tokens.textMuted,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.label,
      letterSpacing: 1.2,
      textTransform: "uppercase" as const,
    },
    value: {
      color: tokens.textPrimary,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.body,
      flexShrink: 1,
      textAlign: "right" as const,
    },
    valueDanger: {
      color: tokens.danger,
    },
  };
}
