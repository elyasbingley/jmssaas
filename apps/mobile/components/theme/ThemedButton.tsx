import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface ThemedButtonProps {
  label: ReactNode;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}

export function ThemedButton({ label, onPress, variant = "primary", disabled }: ThemedButtonProps) {
  const styles = useThemedStyles(createStyles);
  const variantStyle =
    variant === "primary" ? styles.primary : variant === "danger" ? styles.danger : styles.secondary;
  const textStyle = variant === "primary" ? styles.primaryText : styles.secondaryText;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.base, variantStyle, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    base: {
      borderRadius: 3,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignItems: "center" as const,
      borderWidth: 1,
    },
    primary: {
      backgroundColor: tokens.accent,
      borderColor: tokens.accent,
      boxShadow: `0 0 10px ${tokens.accentGlow}`,
    },
    secondary: {
      backgroundColor: "transparent",
      borderColor: tokens.border,
    },
    danger: {
      backgroundColor: "transparent",
      borderColor: tokens.danger,
    },
    disabled: {
      opacity: 0.5,
    },
    pressed: {
      opacity: 0.75,
    },
    primaryText: {
      color: tokens.background,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.button,
      fontWeight: "700" as const,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
    },
    secondaryText: {
      color: tokens.accent,
      fontFamily: fontFamily.mobileFontFamily,
      fontSize: font.button,
      letterSpacing: 1,
      textTransform: "uppercase" as const,
    },
  };
}
